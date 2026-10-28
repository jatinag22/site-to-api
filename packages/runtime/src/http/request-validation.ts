/**
 * The input a generated client validates before sending a request. hey-api's fetch client hands
 * its request validator the resolved options, whose `headers` is a `Headers` instance by then;
 * a Zod object schema reads own properties and so sees no headers at all, which made every
 * required header fail validation. This turns `headers` into a plain object first.
 *
 * Header names are lower-cased (as `Headers` stores them). Pass the spec's names that are not
 * lower case in `headerNames` so they are also present under their exact spelling.
 *
 * Everything other than a `Headers` instance in `headers` is returned unchanged.
 */
export function requestValidationInput(data: unknown, headerNames: readonly string[] = []): unknown {
  if (typeof data !== 'object' || data === null || !('headers' in data) || !(data.headers instanceof Headers))
    return data
  const source = data.headers
  const headers: Record<string, string> = {}
  source.forEach((value, name) => {
    headers[name] = value
  })
  for (const name of headerNames) {
    const value = source.get(name)
    if (value !== null)
      headers[name] = value
  }
  return { ...data, headers }
}
