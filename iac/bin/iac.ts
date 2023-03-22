#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RokiGptStack } from '../lib/iac-stack';

const app = new cdk.App();
const target = app.node.tryGetContext('target')

if (target !== 'dev' && target !== 'prod') {
  throw new Error(`Unexpected target: ${target}`)
}

new RokiGptStack(app, 'RokiGptStack', {
  stackName: `${target}-RokiGptStack`,
});
