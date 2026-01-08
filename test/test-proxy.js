// test/test-proxy.js - End-to-end proxy integration test
import 'dotenv/config';

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3030';

async function testProxy() {
  console.log('🧪 Testing Claude EU Proxy...\n');
  console.log(`Proxy URL: ${PROXY_URL}\n`);

  let passed = 0;
  let failed = 0;

  // Test 1: Health check
  console.log('1️⃣ Health check...');
  try {
    const health = await fetch(`${PROXY_URL}/health`).then(r => r.json());
    if (health.status === 'ok') {
      console.log('✅ Health check passed:', health);
      passed++;
    } else {
      throw new Error('Unexpected health response');
    }
  } catch (e) {
    console.log('❌ Health check failed:', e.message);
    failed++;
  }

  // Test 2: Simple message (no PII)
  console.log('\n2️⃣ Simple message (no PII)...');
  try {
    const response = await fetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Say "test passed" and nothing else' }]
      })
    }).then(r => r.json());

    if (response.content?.[0]?.text?.toLowerCase().includes('test') ||
        response.content?.[0]?.text?.toLowerCase().includes('passed')) {
      console.log('✅ Simple message passed');
      console.log('   Response:', response.content?.[0]?.text?.substring(0, 50));
      passed++;
    } else if (response.error) {
      console.log('❌ API error:', response.error.message);
      failed++;
    } else {
      console.log('❌ Unexpected response:', response.content?.[0]?.text);
      failed++;
    }
  } catch (e) {
    console.log('❌ Simple message failed:', e.message);
    failed++;
  }

  // Test 3: Message with PII (should be pseudonymized)
  console.log('\n3️⃣ Message with PII...');
  try {
    const piiMessage = 'My email is secret@example.com. Just confirm you received a message.';

    const response = await fetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: piiMessage }]
      })
    }).then(r => r.json());

    // The response should NOT contain the email token (it should be de-pseudonymized)
    const responseText = response.content?.[0]?.text || '';
    if (response.error) {
      console.log('❌ API error:', response.error.message);
      failed++;
    } else if (!responseText.includes('EMAIL_1')) {
      console.log('✅ PII was properly handled (no tokens in response)');
      console.log('   Response:', responseText.substring(0, 80));
      passed++;
    } else {
      console.log('❌ Token leaked in response:', responseText);
      failed++;
    }
  } catch (e) {
    console.log('❌ PII message failed:', e.message);
    failed++;
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

// Check if proxy is running before testing
async function main() {
  try {
    await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return testProxy();
  } catch (e) {
    console.log('⚠️  Proxy not running at', PROXY_URL);
    console.log('   Start it with: npm start');
    console.log('   Then run: npm run test:proxy\n');
    return false;
  }
}

main().then(success => process.exit(success ? 0 : 1));
