import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import { Server, ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: IORedis;
  private subClient?: IORedis;

  constructor(
    app: INestApplication,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    if (!this.redisUrl) {
      return;
    }

    try {
      this.pubClient = new IORedis(this.redisUrl, {
        maxRetriesPerRequest: null,
        // `disableClientInfo: true` skips the telemetry CLIENT SETINFO
        // command on (re)connect — purely metadata for `CLIENT INFO`
        // debug output, zero functional impact. We deliberately KEEP
        // `enableReadyCheck` at its default `true` so Socket.IO pub/sub
        // commands wait for Redis to finish loading after restart/
        // failover; the adapter has no retry layer to compensate for
        // LOADING errors.
        disableClientInfo: true,
      });
      this.subClient = this.pubClient.duplicate();

      await Promise.all([
        new Promise<void>((resolve) => this.pubClient!.on('ready', resolve)),
        new Promise<void>((resolve) => this.subClient!.on('ready', resolve)),
      ]);

      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    } catch {
      // Fall back to in-memory adapter if Redis is unavailable.
      // This is expected in development when Redis may not be running.
    }
  }

  async close(): Promise<void> {
    try {
      if (this.pubClient?.status === 'ready') {
        await this.pubClient.quit();
      }
    } catch {
      // Connection may already be closed
    }
    try {
      if (this.subClient?.status === 'ready') {
        await this.subClient.quit();
      }
    } catch {
      // Connection may already be closed
    }
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    return server;
  }
}
