/**
 * Marks GraphQL exchanges and splits batched requests (decision 0027). A batch body
 * (`[{...}, {...}]`) becomes one stand-in exchange per element, with the matching element of the
 * response array, so every later stage sees one GraphQL operation per exchange.
 */
import type { Body, Exchange, GraphqlRequest } from '../../model'
import { detectGraphqlRequests } from './detect'

function jsonBody(mimeType: string, value: unknown): Body {
  return {
    mimeType,
    text: JSON.stringify(value),
    base64: null,
    json: value,
    form: null,
  }
}

function standIn(exchange: Exchange, request: GraphqlRequest, index: number, count: number): Exchange {
  const requestBody = exchange.request.body
  const requestJson: unknown = Array.isArray(requestBody?.json)
    ? requestBody.json[index]
    : undefined
  const responseBody = exchange.response.body
  const responses: unknown = responseBody?.json
  // Servers answer a batch with an array in request order; anything else stays whole.
  const responseJson: unknown = Array.isArray(responses) && responses.length === count
    ? responses[index]
    : undefined
  return {
    ...exchange,
    id: `${exchange.id}:graphql:${index}`,
    request: {
      ...exchange.request,
      body: requestBody
        ? jsonBody(requestBody.mimeType, requestJson)
        : null,
    },
    response: {
      ...exchange.response,
      body: responseBody && responseJson !== undefined
        ? jsonBody(responseBody.mimeType, responseJson)
        : responseBody,
    },
    graphql: request,
  }
}

/**
 * Sets `graphql` on every GraphQL exchange and replaces each batched one by its stand-ins, in
 * place of the original and in element order. Other exchanges are returned unchanged.
 */
export function annotateGraphql(exchanges: Exchange[]): Exchange[] {
  return exchanges.flatMap((exchange) => {
    if (exchange.kind !== 'api')
      return [exchange]
    const requests = detectGraphqlRequests(exchange)
    if (requests === null)
      return [exchange]
    const [first] = requests
    if (requests.length === 1 && first !== undefined && first.batchIndex === null) {
      return [
        { ...exchange, graphql: first },
      ]
    }
    return requests.map((request, index) => standIn(exchange, request, index, requests.length))
  })
}
