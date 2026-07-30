'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractTraceparent, eventTrigger } = require('../lib/serverless');

test('extractTraceparent from API Gateway headers', () => {
  const tp = extractTraceparent({
    headers: { Traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' }
  });
  assert.ok(tp.includes('aaaaaaaa'));
});

test('extractTraceparent from SQS messageAttributes', () => {
  const tp = extractTraceparent({
    Records: [{
      eventSource: 'aws:sqs',
      messageAttributes: { traceparent: { stringValue: '00-cc-dd-01' } }
    }]
  });
  assert.equal(tp, '00-cc-dd-01');
});

test('eventTrigger classification', () => {
  assert.equal(eventTrigger({ requestContext: { http: {} } }), 'http');
  assert.equal(eventTrigger({ Records: [{ eventSource: 'aws:sqs' }] }), 'sqs');
  assert.equal(eventTrigger({ source: 'aws.events' }), 'eventbridge');
});
