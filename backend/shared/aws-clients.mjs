const MOCK_REGISTRY_KEY = Symbol.for("neoncoinarena.awsClientMocks");

const clientCache = new Map();
let cachedGameConfig = {
  loadedAt: 0,
  value: {
    targetCoins: 12,
    scoreMultiplier: 1,
    motd: "",
  },
};

/**
 * Allows unit tests to inject mock AWS SDK clients without network calls.
 */
export function setAwsClientsForTest(mocks) {
  if (mocks) {
    globalThis[MOCK_REGISTRY_KEY] = mocks;
  } else {
    delete globalThis[MOCK_REGISTRY_KEY];
  }
  clientCache.clear();
  cachedGameConfig = {
    loadedAt: 0,
    value: { targetCoins: 12, scoreMultiplier: 1, motd: "" },
  };
}

/**
 * Instantiates an AWS SDK v3 command in Lambda, or returns a test descriptor locally.
 */
export async function makeAwsCommand(pkgName, className, input) {
  try {
    const mod = await import(pkgName);
    return new mod[className](input);
  } catch {
    return { input, __cmd: className };
  }
}

async function getClient(name, loader) {
  const mocks = globalThis[MOCK_REGISTRY_KEY];
  if (mocks && mocks[name]) {
    return mocks[name];
  }
  if (!clientCache.has(name)) {
    clientCache.set(name, await loader());
  }
  return clientCache.get(name);
}

export async function getDynamoClient() {
  return getClient("dynamodb", async () => {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    return new DynamoDBClient({});
  });
}

export async function getApiGwManagementClient(endpoint) {
  const key = `apigw:${endpoint}`;
  const mocks = globalThis[MOCK_REGISTRY_KEY];
  if (mocks?.apigw) {
    return typeof mocks.apigw === "function" ? mocks.apigw(endpoint) : mocks.apigw;
  }
  if (!clientCache.has(key)) {
    const { ApiGatewayManagementApiClient } = await import(
      "@aws-sdk/client-apigatewaymanagementapi"
    );
    clientCache.set(key, new ApiGatewayManagementApiClient({ endpoint }));
  }
  return clientCache.get(key);
}

/**
 * Reads runtime game settings from AWS SSM Parameter Store (cached for 60s).
 */
export async function getGameConfig() {
  const paramName = process.env.SSM_CONFIG_PARAM || "";
  const now = Date.now();
  if (!paramName || now - cachedGameConfig.loadedAt < 60_000) {
    return cachedGameConfig.value;
  }

  try {
    const ssm = await getClient("ssm", async () => {
      const { SSMClient } = await import("@aws-sdk/client-ssm");
      return new SSMClient({});
    });
    const res = await ssm.send(
      await makeAwsCommand("@aws-sdk/client-ssm", "GetParameterCommand", {
        Name: paramName,
      })
    );
    const parsed = JSON.parse(res?.Parameter?.Value || "{}");
    const targetCoins = Math.max(4, Math.min(30, Number(parsed.targetCoins || 12)));
    const scoreMultiplier = Math.max(1, Math.min(5, Number(parsed.scoreMultiplier || 1)));
    const motd = String(parsed.motd || "").slice(0, 140);
    cachedGameConfig = {
      loadedAt: now,
      value: { targetCoins, scoreMultiplier, motd },
    };
  } catch (err) {
    console.warn("SSM config fetch skipped/fallback:", err?.message || err);
    cachedGameConfig.loadedAt = now;
  }
  return cachedGameConfig.value;
}

/**
 * Enqueues an asynchronous gameplay/analytics event into Amazon SQS.
 */
export async function enqueueGameEvent(eventType, detail = {}) {
  const queueUrl = process.env.SQS_QUEUE_URL || "";
  if (!queueUrl) return false;
  try {
    const sqs = await getClient("sqs", async () => {
      const { SQSClient } = await import("@aws-sdk/client-sqs");
      return new SQSClient({});
    });
    await sqs.send(
      await makeAwsCommand("@aws-sdk/client-sqs", "SendMessageCommand", {
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          eventType,
          timestamp: Date.now(),
          ...detail,
        }),
      })
    );
    return true;
  } catch (err) {
    console.warn("SQS enqueue failed:", err?.message || err);
    return false;
  }
}

/**
 * Publishes a custom numeric metric to Amazon CloudWatch.
 */
export async function putGameMetric(metricName, value = 1, unit = "Count", dimensions = []) {
  if (process.env.DISABLE_CW_METRICS === "1") return false;
  if (!process.env.CW_NAMESPACE && !globalThis[MOCK_REGISTRY_KEY]?.cloudwatch) {
    return false;
  }
  const namespace = process.env.CW_NAMESPACE || "NeonCoinArena";
  try {
    const cw = await getClient("cloudwatch", async () => {
      const { CloudWatchClient } = await import("@aws-sdk/client-cloudwatch");
      return new CloudWatchClient({});
    });
    await cw.send(
      await makeAwsCommand("@aws-sdk/client-cloudwatch", "PutMetricDataCommand", {
        Namespace: namespace,
        MetricData: [
          {
            MetricName: metricName,
            Value: Number(value),
            Unit: unit,
            Dimensions: dimensions,
            Timestamp: new Date(),
          },
        ],
      })
    );
    return true;
  } catch (err) {
    console.warn("CloudWatch metric skipped:", err?.message || err);
    return false;
  }
}

/**
 * Sends a milestone or operational alert to Amazon SNS.
 */
export async function publishAlert(subject, message) {
  const topicArn = process.env.SNS_TOPIC_ARN || "";
  if (!topicArn) return false;
  try {
    const sns = await getClient("sns", async () => {
      const { SNSClient } = await import("@aws-sdk/client-sns");
      return new SNSClient({});
    });
    await sns.send(
      await makeAwsCommand("@aws-sdk/client-sns", "PublishCommand", {
        TopicArn: topicArn,
        Subject: String(subject || "Neon Coin Arena").slice(0, 100),
        Message: String(message || ""),
      })
    );
    return true;
  } catch (err) {
    console.warn("SNS publish skipped:", err?.message || err);
    return false;
  }
}

/**
 * Archives a JSON object to Amazon S3 for analytics/leaderboard snapshots.
 */
export async function putS3Json(key, payload) {
  const bucket = process.env.DATA_BUCKET || "";
  if (!bucket) return false;
  try {
    const s3 = await getClient("s3", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      return new S3Client({});
    });
    await s3.send(
      await makeAwsCommand("@aws-sdk/client-s3", "PutObjectCommand", {
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(payload, null, 2),
        ContentType: "application/json",
        CacheControl: "no-cache",
      })
    );
    return true;
  } catch (err) {
    console.warn("S3 putObject skipped:", err?.message || err);
    return false;
  }
}
