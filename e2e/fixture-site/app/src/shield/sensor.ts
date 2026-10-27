/**
 * Toy stand-in for a bot-protection sensor, shaped like Akamai's (`sensor_data` posted to a
 * collector that answers with an `_abck` cookie) so the tool's detection has something to find.
 * It collects nothing about the device or the person and computes nothing: the payload is a fixed
 * version tag plus the page path. Shipped minified with no sourcemap, like the real thing.
 */

function buildSensorPayload(): string {
  return ['2', 'pinewood-toy-sensor', location.pathname].join(';')
}

async function postSensorData(): Promise<void> {
  const response = await fetch('/shield/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sensor_data: buildSensorPayload(),
    }),
    credentials: 'same-origin',
  })
  // Read the body: Chromium keeps an unread response open, which would stop the page from
  // ever reaching network idle.
  await response.text()
  if (!response.ok)
    throw new Error(`shield collector answered ${response.status}`)
}

window.pmShield = {
  ready: postSensorData(),
}
