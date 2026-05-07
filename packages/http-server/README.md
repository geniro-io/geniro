# @packages/http-server

Note: For repository-wide testing and code guidelines, see `.guidelines/testing.md` and `.guidelines/code-guidelines.md`.


This library provides a NestJS module for setting up an HTTP server using `Fastify`. It seamlessly integrates with the `@packages/common` library to provide a complete server solution.

## Installation

```bash
pnpm add @packages/http-server
```

## Core Features

### HTTP Server Setup

- **Fastify Integration**: High-performance HTTP server implementation
- **API Versioning**: Built-in support for API versioning
- **Global Prefix**: Configure a global prefix for all routes
- **Swagger Documentation**: Automatic API documentation generation
- **Compression**: Response compression support
- **CORS**: Cross-Origin Resource Sharing support
- **Helmet**: Security headers configuration

### Health Checker

A built-in health check endpoint (`GET /health/check`) that returns a 200 response with application information, indicating the service is operational.

### Exception Handling

A standardized exception filter that:
- Formats error responses with `statusCode`, `errorCode`, and `message`
- Logs errors to the console
- Sends errors with status codes >= 400 to Sentry (if configured)
- Provides consistent error handling across your application

### Metrics

Automatic metrics collection via `HttpMetricsModule`:
- Application metadata (version, name, pod ID)
- Request timing metrics
- Request count metrics
- Prometheus-compatible endpoint

### Data Validation

Automatic request validation with:
- Global `ValidationPipe` for DTO validation
- Detailed validation error messages
- Support for array validation
- Custom validation pipes

### Request Context

A `RequestContextService` that provides access to the current request data:
- Request ID
- IP address
- HTTP method
- Request body
- URL
- Headers

### Custom Logger

A request-aware logger that automatically includes request context data in log messages.

## Usage Guide

### Basic Integration with Common Package

```typescript
import { buildBootstrapper } from '@packages/common';
import { buildHttpServerExtension } from '@packages/http-server';
import { AppModule } from './app.module';
import { environment } from './environments';

// Create a bootstrapper instance
const bootstrapper = buildBootstrapper({
  environment: environment.env,
  appName: environment.appName,
  appVersion: environment.appVersion,
});

// Add your application modules
bootstrapper.addModules([AppModule]);

// Add HTTP server extension
bootstrapper.addExtension(
  buildHttpServerExtension({
    // Server configuration
    port: environment.port || 3000,

    // API configuration
    globalPrefix: environment.globalPrefix,
    apiDefaultVersion: '1',

    // Swagger configuration
    swagger: {
      path: environment.swaggerPath || '/swagger',
      description: 'API Documentation',
    },

    // Additional options
    compression: { threshold: 1024 },
    helmetOptions: { contentSecurityPolicy: false },
  })
);

// Initialize the application
bootstrapper.init().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
```

## API Reference

### HTTP Server Parameters

```typescript
interface IHttpServerParams {
  // Server configuration
  port?: number;                      // Server port (default: 3000)
  fastifyOptions?: FastifyServerOptions; // Fastify server options

  // API configuration
  globalPrefix?: string;              // Global prefix for all routes
  globalPrefixIgnore?: string[];      // Routes to exclude from global prefix
  apiDefaultVersion?: string;         // Default API version

  // Middleware options
  helmetOptions?: HelmetOptions;      // Helmet security options
  compression?: FastifyCompressOptions; // Response compression options

  // Swagger configuration
  swagger?: {
    path?: string;                    // Swagger UI path
    description?: string;             // API description
    securitySchemas?: Record<string, any>; // Security schemas
    options?: SwaggerCustomOptions;   // Additional Swagger options
  };
}
```

### buildHttpServerExtension

```typescript
function buildHttpServerExtension(params: IHttpServerParams): IAppBootstrapperExtension;
```

Creates an extension for the AppBootstrapper that sets up an HTTP server with the specified configuration.

## Data Validation Features

### CustomArrayValidationPipe

A pipe for validating arrays in request bodies:

```typescript
@Post('items')
@ApiBody({ type: [CreateItemDto] })
createItems(
  @Body(new CustomArrayValidationPipe({ items: CreateItemDto }))
  items: CreateItemDto[],
) {
  return this.itemsService.createMany(items);
}
```

### TransformQueryArray Decorator

For handling query parameter arrays:

```typescript
export class GetItemsDto {
  @IsNumber(undefined, { each: true })
  @IsArray()
  @TransformQueryArray(Number)
  ids: number[];
}
```

This decorator ensures that query parameters are correctly parsed as arrays and transformed to the specified type.

### ApiEnumProperty Decorator

For proper enum handling in Swagger documentation:

```typescript
export class FilterDto {
  @IsEnum(ItemType, { each: true })
  @ApiEnumProperty({
    enum: ItemType,
    enumType: 'string',
    isArray: true,
    transform: 'string'
  })
  types: ItemType[];
}
```

## Authentication Providers

The HTTP server includes a flexible authentication system that supports multiple authentication providers:

### Available Providers

- **KeycloakProvider**: Integration with Keycloak identity provider
- **Auth0Provider**: Integration with Auth0 identity provider
- **Custom Providers**: Create your own by extending the `AuthProvider` abstract class

### Basic Usage

```typescript
import { buildBootstrapper } from '@packages/common';
import { 
  buildHttpServerExtension, 
  buildAuthExtension,
  AuthModule, 
  KeycloakProvider,
  AuthProvider
} from '@packages/http-server';
import { AppModule } from './app.module';

// Create a bootstrapper instance
const bootstrapper = buildBootstrapper({
  environment: 'development',
  appName: 'my-app',
  appVersion: '1.0.0',
});

// Configure Keycloak provider
const keycloakProvider =  new KeycloakProvider({ 
    url: 'https://auth.example.com',
    realms: ['master'],
}),

bootstrapper.addModules([AppModule]);

// Add HTTP server extension
bootstrapper.addExtension(
  buildHttpServerExtension({
    port: 3000,
  })
);

// Add auth extension
bootstrapper.addExtension(
  buildAuthExtension({
    provider: keycloakProvider,
    devMode: process.env.NODE_ENV !== 'production',
  })
);

// Initialize the application
bootstrapper.init();
```

### Using Auth0 Provider

```typescript
import { Auth0Provider, AuthProvider, buildAuthExtension, buildHttpServerExtension } from '@packages/http-server';

// Configure Auth0 provider
const auth0Provider = new Auth0Provider('your-auth0-domain.auth0.com'),

// Add HTTP server extension
bootstrapper.addExtension(
  buildHttpServerExtension({
    port: 3000,
  })
);

// Add auth extension
bootstrapper.addExtension(
  buildAuthExtension({
    provider: auth0Provider,
    devMode: process.env.NODE_ENV !== 'production',
  })
);
```

### Creating Custom Providers

You can create custom authentication providers by extending the `AuthProvider` abstract class:

```typescript
import { AuthProvider, IContextData } from '@packages/http-server';

export class CustomAuthProvider extends AuthProvider {
  public async verifyToken(token: string): Promise<IContextData> {
    // Implement your token verification logic here
    // Return context data with at least a 'sub' property
    return {
      sub: 'user-id',
    };
  }
}
```

### Accessing Authentication Context

Use the `AuthContextService` to access the authenticated user's information:

```typescript
import { AuthContextService } from '@packages/http-server';

@Injectable()
export class MyService {
  constructor(private readonly authContext: AuthContextService) {}

  async doSomething() {
    // Get the current user's ID
    const userId = this.authContext.sub;

    // Use the user ID in your business logic
    console.log(`Processing request for user ${userId}`);
  }
}
```

## Request Context Usage

Access the current request context from anywhere in your application:

```typescript
import { RequestContextService } from '@packages/http-server';

@Injectable()
export class MyService {
  constructor(private readonly contextService: RequestContextService) {}

  async doSomething() {
    const requestId = this.contextService.getRequestId();
    const clientIp = this.contextService.getIp();

    // Use request context data
    console.log(`Processing request ${requestId} from ${clientIp}`);
  }
}
```
