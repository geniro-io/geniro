# GitAuthApi

All URIs are relative to _http://localhost_

| Method                                        | HTTP request                                                      | Description |
| --------------------------------------------- | ----------------------------------------------------------------- | ----------- |
| [**deletePat**](#deletepat)                   | **DELETE** /api/v1/git-auth/pat                                   |             |
| [**disconnectAll**](#disconnectall)           | **DELETE** /api/v1/git-auth/github/disconnect                     |             |
| [**getSetupInfo**](#getsetupinfo)             | **GET** /api/v1/git-auth/github/setup                             |             |
| [**getStatus**](#getstatus)                   | **GET** /api/v1/git-auth/pat                                      |             |
| [**linkViaOAuthCode**](#linkviaoauthcode)     | **POST** /api/v1/git-auth/github/oauth/link                       |             |
| [**listInstallations**](#listinstallations)   | **GET** /api/v1/git-auth/github/installations                     |             |
| [**setPat**](#setpat)                         | **PUT** /api/v1/git-auth/pat                                      |             |
| [**unlinkInstallation**](#unlinkinstallation) | **DELETE** /api/v1/git-auth/github/installations/{installationId} |             |

# **deletePat**

> deletePat()

### Example

```typescript
import { GitAuthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

const { status, data } = await apiInstance.deletePat();
```

### Parameters

This endpoint does not have any parameters.

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

# **disconnectAll**

> UnlinkInstallationResponseDto disconnectAll()

### Example

```typescript
import { GitAuthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

const { status, data } = await apiInstance.disconnectAll();
```

### Parameters

This endpoint does not have any parameters.

### Return type

**UnlinkInstallationResponseDto**

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

# **getSetupInfo**

> SetupInfoResponseDto getSetupInfo()

### Example

```typescript
import { GitAuthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

const { status, data } = await apiInstance.getSetupInfo();
```

### Parameters

This endpoint does not have any parameters.

### Return type

**SetupInfoResponseDto**

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

# **getStatus**

> GitUserPatStatusResponseDto getStatus()

### Example

```typescript
import { GitAuthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

const { status, data } = await apiInstance.getStatus();
```

### Parameters

This endpoint does not have any parameters.

### Return type

**GitUserPatStatusResponseDto**

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

# **linkViaOAuthCode**

> LinkInstallationResponseDto linkViaOAuthCode(oAuthLinkRequestDto)

### Example

```typescript
import { GitAuthApi, Configuration, OAuthLinkRequestDto } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

let oAuthLinkRequestDto: OAuthLinkRequestDto; //

const { status, data } =
  await apiInstance.linkViaOAuthCode(oAuthLinkRequestDto);
```

### Parameters

| Name                    | Type                    | Description | Notes |
| ----------------------- | ----------------------- | ----------- | ----- |
| **oAuthLinkRequestDto** | **OAuthLinkRequestDto** |             |       |

### Return type

**LinkInstallationResponseDto**

### Authorization

[bearer](../README.md#bearer)

### HTTP request headers

- **Content-Type**: application/json
- **Accept**: application/json

### HTTP response details

| Status code | Description | Response headers |
| ----------- | ----------- | ---------------- |
| **201**     |             | -                |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listInstallations**

> ListInstallationsResponseDto listInstallations()

### Example

```typescript
import { GitAuthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

const { status, data } = await apiInstance.listInstallations();
```

### Parameters

This endpoint does not have any parameters.

### Return type

**ListInstallationsResponseDto**

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

# **setPat**

> GitUserPatStatusResponseDto setPat(setGitUserPatRequestDto)

### Example

```typescript
import { GitAuthApi, Configuration, SetGitUserPatRequestDto } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

let setGitUserPatRequestDto: SetGitUserPatRequestDto; //

const { status, data } = await apiInstance.setPat(setGitUserPatRequestDto);
```

### Parameters

| Name                        | Type                        | Description | Notes |
| --------------------------- | --------------------------- | ----------- | ----- |
| **setGitUserPatRequestDto** | **SetGitUserPatRequestDto** |             |       |

### Return type

**GitUserPatStatusResponseDto**

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

# **unlinkInstallation**

> UnlinkInstallationResponseDto unlinkInstallation()

### Example

```typescript
import { GitAuthApi, Configuration } from './api';

const configuration = new Configuration();
const apiInstance = new GitAuthApi(configuration);

let installationId: string; // (default to undefined)

const { status, data } = await apiInstance.unlinkInstallation(installationId);
```

### Parameters

| Name               | Type         | Description | Notes                 |
| ------------------ | ------------ | ----------- | --------------------- |
| **installationId** | [**string**] |             | defaults to undefined |

### Return type

**UnlinkInstallationResponseDto**

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
