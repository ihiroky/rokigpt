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
  return replies.messages.map((m) => {
    const content = m.text ?? ''
    if (botMentionRe.test(content)) {
      return {
        role: ChatCompletionRequestMessageRoleEnum.System,
        content: content.replace(botMentionRe, '')
      }
    }
    if (m.bot_id && m.bot_id === context.botId) {
      return {
        role: ChatCompletionRequestMessageRoleEnum.Assistant,
        content,
      }
    }
    return {
      role: ChatCompletionRequestMessageRoleEnum.User,
      content
    }
  })
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
  mapRequests: (messages: ChatCompletionRequestMessage[]) => ChatCompletionRequestMessage[]
}

async function completeChat({
  openAiApi,
  slackBotToken,
  chatModelName,
  args,
  mapRequests,
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

  const requests = toChatCompletionRequestMessages(context, replies)
  logger.debug('requests', requests.length)
  if (requests.length === 0) {
    return
  }
  // TODO assistantが連続で喋ったら連続しているもののうち最新だけ残す？
  const mapped = mapRequests(requests)
  logger.debug('mapped', mapped.length)
  if (mapped.length === 0) {
    return
  }
  const messages = dropMessages(mapped)
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

function convertSystemToUser(message: ChatCompletionRequestMessage[]): ChatCompletionRequestMessage[] {
  return message.map(
    (m) => (m.role === 'system')
      ? { ...m, role: ChatCompletionRequestMessageRoleEnum.User }
      : m
  )
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
      mapRequests: (rs) => rs[0].role === 'system' ? rs : convertSystemToUser(rs),
    })
  })

  app.event('message', async (args) => {
    const { context, logger, event } = args
    logger.debug('event', event.type)
    if (guardRetry(context, logger)) {
      return
    }
    // Reply in threads only.
    if (!('thread_ts' in event)) {
      return
    }
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
      mapRequests: (rs) => (rs[0].role === 'system') ? rs : [],
    })
  })

  return {
    openAiApi,
  }
}
