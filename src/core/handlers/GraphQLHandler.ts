import type { DocumentNode, GraphQLError, OperationTypeNode } from 'graphql'
import {
  DefaultBodyType,
  RequestHandler,
  RequestHandlerDefaultInfo,
  RequestHandlerOptions,
  ResponseResolver,
} from './RequestHandler'
import { getTimestamp } from '../utils/logging/getTimestamp'
import { getStatusCodeColor } from '../utils/logging/getStatusCodeColor'
import { serializeRequest } from '../utils/logging/serializeRequest'
import { serializeResponse } from '../utils/logging/serializeResponse'
import { matchRequestUrl, Path } from '../utils/matching/matchRequestUrl'
import {
  ParsedGraphQLRequest,
  GraphQLMultipartRequestBody,
  parseGraphQLRequest,
  parseDocumentNode,
} from '../utils/internal/parseGraphQLRequest'
import { getPublicUrlFromRequest } from '../utils/request/getPublicUrlFromRequest'
import { devUtils } from '../utils/internal/devUtils'

export type ExpectedOperationTypeNode = OperationTypeNode | 'all'
export type GraphQLHandlerNameSelector = DocumentNode | RegExp | string

export type GraphQLVariables = Record<string, any>

export interface GraphQLHandlerInfo extends RequestHandlerDefaultInfo {
  operationType: ExpectedOperationTypeNode
  operationName: GraphQLHandlerNameSelector
}

export type GraphQLResolverExtras<Variables extends GraphQLVariables> = {
  query: string
  operationName: string
  variables: Variables
}

export type GraphQLRequestBody<VariablesType extends GraphQLVariables> =
  | GraphQLJsonRequestBody<VariablesType>
  | GraphQLMultipartRequestBody
  | Record<string, any>
  | undefined

export interface GraphQLJsonRequestBody<Variables extends GraphQLVariables> {
  query: string
  variables?: Variables
}

export interface GraphQLResponseBody<BodyType extends DefaultBodyType> {
  data?: BodyType
  errors?: readonly Partial<GraphQLError>[]
}

export function isDocumentNode(
  value: DocumentNode | any,
): value is DocumentNode {
  if (value == null) {
    return false
  }

  return typeof value === 'object' && 'kind' in value && 'definitions' in value
}

export class GraphQLHandler extends RequestHandler<
  GraphQLHandlerInfo,
  ParsedGraphQLRequest,
  GraphQLResolverExtras<any>
> {
  private endpoint: Path

  constructor(
    operationType: ExpectedOperationTypeNode,
    operationName: GraphQLHandlerNameSelector,
    endpoint: Path,
    resolver: ResponseResolver<GraphQLResolverExtras<any>, any, any>,
    options?: RequestHandlerOptions,
  ) {
    let resolvedOperationName = operationName

    if (isDocumentNode(operationName)) {
      const parsedNode = parseDocumentNode(operationName)

      if (parsedNode.operationType !== operationType) {
        throw new Error(
          `Failed to create a GraphQL handler: provided a DocumentNode with a mismatched operation type (expected "${operationType}", but got "${parsedNode.operationType}").`,
        )
      }

      if (!parsedNode.operationName) {
        throw new Error(
          `Failed to create a GraphQL handler: provided a DocumentNode with no operation name.`,
        )
      }

      resolvedOperationName = parsedNode.operationName
    }

    const header =
      operationType === 'all'
        ? `${operationType} (origin: ${endpoint.toString()})`
        : `${operationType} ${resolvedOperationName} (origin: ${endpoint.toString()})`

    super({
      info: {
        header,
        operationType,
        operationName: resolvedOperationName,
      },
      resolver,
      options,
    })

    this.endpoint = endpoint
  }

  async parse(args: { request: Request }) {
    return parseGraphQLRequest(args.request).catch((error) => {
      console.error(error)
      return undefined
    })
  }

  predicate(args: { request: Request; parsedResult: ParsedGraphQLRequest }) {
    if (!args.parsedResult) {
      return false
    }

    if (!args.parsedResult.operationName && this.info.operationType !== 'all') {
      const publicUrl = getPublicUrlFromRequest(args.request)

      devUtils.warn(`\
Failed to intercept a GraphQL request at "${args.request.method} ${publicUrl}": anonymous GraphQL operations are not supported.

Consider naming this operation or using "graphql.operation()" request handler to intercept GraphQL requests regardless of their operation name/type. Read more: https://mswjs.io/docs/api/graphql/operation`)
      return false
    }

    const hasMatchingUrl = matchRequestUrl(
      new URL(args.request.url),
      this.endpoint,
    )
    const hasMatchingOperationType =
      this.info.operationType === 'all' ||
      args.parsedResult.operationType === this.info.operationType

    const hasMatchingOperationName =
      this.info.operationName instanceof RegExp
        ? this.info.operationName.test(args.parsedResult.operationName || '')
        : args.parsedResult.operationName === this.info.operationName

    return (
      hasMatchingUrl.matches &&
      hasMatchingOperationType &&
      hasMatchingOperationName
    )
  }

  protected extendResolverArgs(args: {
    request: Request
    parsedResult: ParsedGraphQLRequest<GraphQLVariables>
  }) {
    return {
      query: args.parsedResult?.query || '',
      operationName: args.parsedResult?.operationName || '',
      variables: args.parsedResult?.variables || {},
    }
  }

  async log(args: {
    request: Request
    response: Response
    parsedResult: ParsedGraphQLRequest
  }) {
    const loggedRequest = await serializeRequest(args.request)
    const loggedResponse = await serializeResponse(args.response)
    const statusColor = getStatusCodeColor(loggedResponse.status)
    const requestInfo = args.parsedResult?.operationName
      ? `${args.parsedResult?.operationType} ${args.parsedResult?.operationName}`
      : `anonymous ${args.parsedResult?.operationType}`

    console.groupCollapsed(
      devUtils.formatMessage(
        `${getTimestamp()} ${requestInfo} (%c${loggedResponse.status} ${
          loggedResponse.statusText
        }%c)`,
      ),
      `color:${statusColor}`,
      'color:inherit',
    )
    console.log('Request:', loggedRequest)
    console.log('Handler:', this)
    console.log('Response:', loggedResponse)
    console.groupEnd()
  }
}
