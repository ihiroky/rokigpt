import { App, AwsLambdaReceiver } from '@slack/bolt'
import { APIGatewayProxyHandler } from 'aws-lambda'
import { setup } from './app'

const openAiApiKey = process.env.OPEN_AI_API_KEY ?? ''
const slackBotToken = process.env.SLACK_BOT_TOKEN ?? ''
const receiver = new AwsLambdaReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? ''
})
const app = new App({ token: slackBotToken, receiver })

setup(app, openAiApiKey, slackBotToken)

export const handler: APIGatewayProxyHandler = async (event, context, callback) => {
  const awsLambdaReceiverHandler = await receiver.start();
  return awsLambdaReceiverHandler(event, context, callback);
}
