import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import { LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway'
import { StringParameter } from 'aws-cdk-lib/aws-ssm'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { Construct } from 'constructs';

export class RokiGptStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { stackName: string }) {
    super(scope, id, props)

    const stackName = props.stackName
    const slackSigningSecret = StringParameter.valueForStringParameter(this, `${stackName}SlackSigningSecret`)
    const slackBotToken = StringParameter.valueForStringParameter(this, `${stackName}SlackBotToken`)
    const openAiApiKey = StringParameter.valueForStringParameter(this, `${stackName}OpenAiApiKey`)

    const lambdaFunction = new NodejsFunction(this, `${stackName}Function`, {
      runtime: Runtime.NODEJS_18_X,
      entry: '../app/dist/lambda.js',
      environment: {
        SLACK_SIGNING_SECRET: slackSigningSecret,
        SLACK_BOT_TOKEN: slackBotToken,
        OPEN_AI_API_KEY: openAiApiKey,
      },
      timeout: Duration.minutes(5)
    })

    const apiGateway = new RestApi(this, `${stackName}Gateway`, {
      deployOptions: {
        stageName: `${stackName}GatewayStage`,
      },
    })
    apiGateway.root.addProxy({
      defaultIntegration: new LambdaIntegration(lambdaFunction),
    })
  }
}