import { App, Context, SlackEventMiddlewareArgs, AllMiddlewareArgs } from '@slack/bolt'
import { Logger } from '@slack/logger'
import { ConversationsRepliesResponse } from '@slack/web-api'
import { ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, Configuration, OpenAIApi } from 'openai'

function newBotMentionRegExp(context: Context): RegExp {
  return new RegExp(`[\s\r\n]*<@${context.botUserId}>[\s\r\n]*`)
}

function toChatCompletionRequestMessages(context: Context, replies: ConversationsRepliesResponse): ChatCompletionRequestMessage[] {
  if (!replies.messages) {
    return []
  }

  // TODO このあたりで createChatCompletion のパラメータ抽出する？

  const botMentionRe = newBotMentionRegExp(context)
  const msgs: ChatCompletionRequestMessage[] = replies.messages.map((m) => {
    const content = m.text ?? ''
    if (m.bot_id && m.bot_id === context.botId) {
      return {
        role: ChatCompletionRequestMessageRoleEnum.Assistant,
        content,
      }
    }
    return {
      role: ChatCompletionRequestMessageRoleEnum.User,
      content: content.replace(botMentionRe, '')
    }
  })

  // TODO modifiable by user.
  msgs.unshift({
    role: ChatCompletionRequestMessageRoleEnum.System,
    content: 'You are a helpful startup assistant.',
  })

  return msgs
}

function dropMessages(messages: ChatCompletionRequestMessage[]): ChatCompletionRequestMessage[] {
  if (messages.length === 0) {
    return []
  }

  const nonSystemIndices = messages
    .map((v, i) => v.role !== ChatCompletionRequestMessageRoleEnum.System ? i : -1)
    .filter((i) => i !== -1)
  const availableNonSystemMessageCount = 13 // Should be as long as possible
  if (nonSystemIndices.length <= availableNonSystemMessageCount) {
    return messages
  }
  const dropIndexSet = new Set(nonSystemIndices.slice(0, nonSystemIndices.length - availableNonSystemMessageCount))
  return messages.filter((v, i) => !dropIndexSet.has(i))
}

type CompleteChatProps = {
  openAiApi: OpenAIApi,
  slackBotToken: string,
  chatModelName: string,
  args: SlackEventMiddlewareArgs<'app_mention' | 'message'> & AllMiddlewareArgs,
  isCompletable: (context: AllMiddlewareArgs['context'], replies: ConversationsRepliesResponse) => boolean,
}

async function completeChat({
  openAiApi,
  slackBotToken,
  chatModelName,
  args,
  isCompletable,
}: CompleteChatProps) {
  const { context, client, event, say, logger } = args
  const channel = event.channel
  const thread_ts = ('thread_ts' in event) ? (event.thread_ts ?? event.ts) : event.ts

  const replies = await client.conversations.replies({
    token: slackBotToken,
    channel,
    ts: thread_ts,
    inclusive: true,
  })
  if (!isCompletable(context, replies)) {
    return
  }

  const requests = toChatCompletionRequestMessages(context, replies)
  logger.debug('requests', requests.length)
  if (requests.length === 0) {
    return
  }
  const messages = dropMessages(requests)
  logger.debug('dropped', messages.length)
  if (messages.length === 0) {
    return
  }

  try {
    const completion = await openAiApi.createChatCompletion({
      model: chatModelName,
      messages,
    })
    await say({
      channel,
      thread_ts,
      text: completion.data.choices[0].message?.content
    })
    logger.debug({
      message: completion.data.choices[0].message?.content
    })
  } catch (e: unknown) {
    logger.error(e)
    const message = (e instanceof Error) ? e.toString() : JSON.stringify(e)
    await say({
      channel,
      thread_ts,
      text: `Unexpected error occurs. Please start a conversation in a new thread: ${message}`,
    })
  }
}

function guardRetry(context: Context, logger: Logger): boolean {
  if (context.retryReason !== 'http_timeout') {
    return false
  }

  logger.info({
    message: 'Timeout resend rquest from Slack.'
  })
  return true
}

function isFirstMessageMentioned(context: AllMiddlewareArgs['context'], replies: ConversationsRepliesResponse): boolean {
  if (!replies.messages || replies.messages.length === 0 || !replies.messages[0].text) {
    return false
  }

  const botMention = newBotMentionRegExp(context)
  return botMention.test(replies.messages[0].text)
}

type SetupProps = {
  app: App,
  openAiApiKey: string,
  slackBotToken: string,
  chatModelName: string,
}

export function setup({
  app,
  openAiApiKey,
  slackBotToken,
  chatModelName,
}: SetupProps): { openAiApi: OpenAIApi } {
  const openAiApi = new OpenAIApi(new Configuration({
    apiKey: openAiApiKey
  }))

  console.info(`Chat model name: ${chatModelName}`)

  app.event('app_mention', async (args) => {
    const { context, logger, event } = args
    logger.debug('event', event.type)
    if (guardRetry(context, logger)) {
      return
    }

    await completeChat({
      openAiApi,
      slackBotToken,
      chatModelName,
      args,
      isCompletable: () => true,
    })
  })

  /**
   * Reply only in a thread if its first message is bot mentioned.
   */
  app.event('message', async (args) => {
    const { context, logger, event } = args
    logger.debug('event', event.type)
    if (guardRetry(context, logger)) {
      return
    }
    if (!('thread_ts' in event)) {
      return
    }
    // Stop if this message in the thread is bot mention, which is replied by 'app_mention'.
    if ('text' in args.message) {
      const botMention = newBotMentionRegExp(context)
      if (args.message.text && botMention.test(args.message.text)) {
        logger.debug('The message event detects bot mention. Skip.')
        return
      }
    }

    await completeChat({
      openAiApi,
      slackBotToken,
      chatModelName,
      args,
      isCompletable: isFirstMessageMentioned,
    })
  })

  return {
    openAiApi,
  }
}
