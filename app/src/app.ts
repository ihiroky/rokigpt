import { App, Context, SayFn } from '@slack/bolt'
import { Logger } from '@slack/logger'
import { WebClient, ConversationsRepliesResponse } from '@slack/web-api'
import { ChatCompletionRequestMessage, ChatCompletionRequestMessageRoleEnum, Configuration, OpenAIApi } from 'openai'


function toChatCompletionRequestMessages(context: Context, replies: ConversationsRepliesResponse): ChatCompletionRequestMessage[] {
  if (!replies.messages) {
    return []
  }

  // TODO このあたりで createChatCompletion のパラメータ抽出する？

  const botMentionRe = new RegExp(`^<@${context.botUserId}>[ \t\r\n]*`)
  const messages = replies.messages.map((m) => {
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

  // Drop past contents to reduce token consumption.
  const nonSystemIndices = messages
    .map((v, i) => v.role !== ChatCompletionRequestMessageRoleEnum.System ? i : -1)
    .filter((i) => i !== -1)
  const availableNonSystemMessageCount = 13 // Need to adjust
  if (nonSystemIndices.length <= availableNonSystemMessageCount) {
    return messages
  }
  const dropIndexSet = new Set(nonSystemIndices.slice(0, nonSystemIndices.length - availableNonSystemMessageCount))
  return messages.filter((v, i) => !dropIndexSet.has(i))
}

type CompleteChatProps = {
  openAiApi: OpenAIApi
  slackBotToken: string,
  context: Context,
  client: WebClient,
  say: SayFn,
  logger: Logger,
  channel: string,
  threadTs: string

}

async function completeChat({ openAiApi, slackBotToken, context, client, say, logger, channel, threadTs }: CompleteChatProps) {
  const replies = await client.conversations.replies({
    token: slackBotToken,
    channel,
    ts: threadTs,
    inclusive: true,
  })

  const messages = toChatCompletionRequestMessages(context, replies)
  if (!messages[0] || messages[0].role !== ChatCompletionRequestMessageRoleEnum.System) {
    return
  }

  logger.debug({
    messag: JSON.stringify(messages, undefined, 2)
  })

  try {
    const completion = await openAiApi.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages,
    })
    await say({
      channel: channel,
      thread_ts: threadTs,
      text: completion.data.choices[0].message?.content
    })
    logger.debug({
      message: completion.data.choices[0].message?.content
    })
  } catch (e: unknown) {
    logger.error(e)
    const message = (e instanceof Error) ? e.toString() : JSON.stringify(e)
    await say({
      channel: channel,
      thread_ts: threadTs,
      text: `Unexpected error occurs. Please start a conversation in a new thread: ${message}`,
    })
  }
}

function guardRetry(context: Context, logger: Logger): boolean {
  if (context.retryNum === undefined || context.retryReason !== 'http_timeout') {
    // Add debug log to investigate duplicated responses.
    if (context.retryNum !== undefined) {
      logger.debug({
        retryNum: context.retryNum,
        retryReason: context.retryReason,
      })
    }
    return false
  }

  logger.info({
    message: 'Timeout resend rquest from Slack.'
  })
  return true
}

export function setup(app: App, openAiApiKey: string, slackBotToken: string): { openAiApi: OpenAIApi } {
  const openAiApi = new OpenAIApi(new Configuration({
    apiKey: openAiApiKey
  }))

  app.event('app_mention', async ({ event, client, say, context, logger, body, ...rest }) => {
    if (guardRetry(context, logger)) {
      return
    }

    const channel = event.channel
    const threadTs = event.thread_ts ?? event.ts
    await completeChat({ openAiApi, slackBotToken, context, client, say, logger, channel, threadTs })
  })

  app.event('message', async ({ event, say, client, context, logger, body, payload, ...rest }) => {
    if (guardRetry(context, logger)) {
      return
    }
    if (!('thread_ts' in event)) {
      return
    }

    const channel = event.channel
    const threadTs = event.thread_ts!
    await completeChat({ openAiApi, slackBotToken, context, client, say, logger, channel, threadTs })
  })

  return {
    openAiApi,
  }
}