# OauthApi

All URIs are relative to _http://localhost_

| Method                                                      | HTTP request                                    | Description |
| ----------------------------------------------------------- | ----------------------------------------------- | ----------- |
| [**disconnectOAuthCredential**](#disconnectoauthcredential) | **DELETE** /api/v1/oauth/{provider}/credentials |             |
| [**exchange**](#exchange)                                   | **POST** /api/v1/oauth/credentials/exchange     |             |
| [**listOAuthCredentials**](#listoauthcredentials)           | **GET** /api/v1/oauth/credentials               |             |
| [**start**](#start)                                         | **GET** /api/v1/oauth/{provider}/start          |             |
| [**status**](#status)                                       | **GET** /api/v1/oauth/{provider}/status         |             |

# **disconnectOAuthCredential**

> disconnectOAuthCredential()

### Example

```typescript
import { OauthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

let provider: 'linear'; // (default to undefined)

const { status, data } = await apiInstance.disconnectOAuthCredential(provider);
```

### Parameters

| Name         | Type                                              | Description | Notes                 |
| ------------ | ------------------------------------------------- | ----------- | --------------------- |
| **provider** | [**&#39;linear&#39;**]**Array<&#39;linear&#39;>** |             | defaults to undefined |

### Return type

void (empty response body)

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: Not defined

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **204**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **exchange**

> OAuthExchangeResponseDto exchange(oAuthExchangeRequestDto)

### Example

```typescript
import { OauthApi, Configuration, OAuthExchangeRequestDto } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

let oAuthExchangeRequestDto: OAuthExchangeRequestDto; //

const { status, data } = await apiInstance.exchange(oAuthExchangeRequestDto);
```

### Parameters

| Name                        | Type                        | Description | Notes |
| --------------------------- | --------------------------- | ----------- | ----- |
| **oAuthExchangeRequestDto** | **OAuthExchangeRequestDto** |             |       |

### Return type

**OAuthExchangeResponseDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listOAuthCredentials**

> Array<OAuthStatusResponseDto> listOAuthCredentials()

### Example

```typescript
import { OauthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

const { status, data } = await apiInstance.listOAuthCredentials();
```

### Parameters

This endpoint does not have any parameters.

### Return type

**Array<OAuthStatusResponseDto>**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **start**

> OAuthStartResponseDto start()

### Example

```typescript
import { OauthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

let provider: 'linear'; // (default to undefined)
let graphId: string; // (optional) (default to undefined)
let nodeId: string; // (optional) (default to undefined)
let threadId: string; //Resume target for a run that paused awaiting this credential; carried into the pending state so the `credential.acquired` signal can resume the exact thread. (optional) (default to undefined)
let cap: string; //Opaque single-use capability token from an `auth_required` notification. Re-opens a paused run\'s OAuth flow from any browser — the project + thread context is recovered server-side from the token, so the editor tab is not required. (optional) (default to undefined)

const { status, data } = await apiInstance.start(
  provider,
  graphId,
  nodeId,
  threadId,
  cap,
);
```

### Parameters

| Name         | Type                                              | Description                                                                                                                                                                                                                                            | Notes                            |
| ------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| **provider** | [**&#39;linear&#39;**]**Array<&#39;linear&#39;>** |                                                                                                                                                                                                                                                        | defaults to undefined            |
| **graphId**  | [**string**]                                      |                                                                                                                                                                                                                                                        | (optional) defaults to undefined |
| **nodeId**   | [**string**]                                      |                                                                                                                                                                                                                                                        | (optional) defaults to undefined |
| **threadId** | [**string**]                                      | Resume target for a run that paused awaiting this credential; carried into the pending state so the &#x60;credential.acquired&#x60; signal can resume the exact thread.                                                                                | (optional) defaults to undefined |
| **cap**      | [**string**]                                      | Opaque single-use capability token from an &#x60;auth_required&#x60; notification. Re-opens a paused run\&#39;s OAuth flow from any browser — the project + thread context is recovered server-side from the token, so the editor tab is not required. | (optional) defaults to undefined |

### Return type

**OAuthStartResponseDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **status**

> OAuthStatusResponseDto status()

### Example

```typescript
import { OauthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new OauthApi(configuration);

let provider: 'linear'; // (default to undefined)

const { status, data } = await apiInstance.status(provider);
```

### Parameters

| Name         | Type                                              | Description | Notes                 |
| ------------ | ------------------------------------------------- | ----------- | --------------------- |
| **provider** | [**&#39;linear&#39;**]**Array<&#39;linear&#39;>** |             | defaults to undefined |

### Return type

**OAuthStatusResponseDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **200**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
