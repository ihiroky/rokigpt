# rokigpt

Slack App OpenAI ChatCompletion Integration, powered by AWS Lambda

## Deployment instruction to AWS Lambda

- Add parameters below into Parameter Store in AWS System Manager

|Name|Value|
|---|---|
|prod-RokiGptStackChatModelName|OpenAI model name like `gpt-4`|
|prod-RokiGptStackOpenAiApiKey|OpenAI API Key|
|prod-RokiGptStackSlackBotToken|Slack App Bot User OAuth Token|
|prod-RokiGptStackSlackSigningSecret|Slack App Signing Secret|


- Build application
```shell
cd app
npm install
npm run build-lambda
```

- Deploy stack
```shell
cd iac
npm install
npx cdk deploy RokiGptStack -c target=prod
```

### Slack App configuration
- Bot Token Scopes in OAuth & Permissions
  - `app_mentions:read`
  - `channels:history`
  - `chat:write`
- Request URL in Enable Events
  - API Gateway URL like `https://hogehoge.execute-api.ap-northeast-1.amazonaws.com/prod-RokiGptStackGatewayStage/slack/events`
