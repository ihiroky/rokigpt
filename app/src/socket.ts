import { App } from '@slack/bolt'
import { setup } from './app'

const openAiApiKey = process.env.OPEN_AI_API_KEY ?? ''
const slackBotToken = process.env.SLACK_BOT_TOKEN ?? ''
const chatModelName = process.env.CHAT_MODEL_NAME ?? 'gpt-3.5-turbo'
const app = new App({
  token: slackBotToken,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

const { openAiApi } = setup({ app, openAiApiKey, slackBotToken, chatModelName })

;(async () => {
  await openAiApi.listModels().then((d) => {
    d.data.data.forEach(v => {
      console.info(v.id, v.object, v.owned_by)
    })
  })

  await app.start(process.env.PORT || 3000);
  console.info('⚡️ Bolt app is running!');
})()
