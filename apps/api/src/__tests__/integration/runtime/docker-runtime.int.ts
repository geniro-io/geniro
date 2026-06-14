import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { environment } from '../../../environments';
import { resolveDockerOptions } from '../../../v1/runtime/runtime.utils';
import { DockerRuntime } from '../../../v1/runtime/services/docker-runtime';

describe('DockerRuntime Timeout Recovery Integration', () => {
  let runtime: DockerRuntime;

  beforeAll(async () => {
    runtime = new DockerRuntime(resolveDockerOptions(environment), {
      image: 'node:22-alpine',
    });

    await runtime.start({
      containerName: `test-timeout-recovery-${Date.now()}`,
      recreate: true,
    });
  }, 60000);

  afterAll(async () => {
    if (runtime) {
      await runtime.stop();
    }
  }, 30000);

  it(
    'recovers after tail timeout and runs next command successfully',
    { timeout: 15000 },
    async () => {
      // This test verifies that when a command times out due to tail timeout,
      // the session is restarted and the next command can execute successfully
      const sessionId = 'sess-timeout-recovery';

      // First command: produce initial output, then go silent long enough
      // to trigger tail timeout.
      const timeoutResult = await runtime.exec({
        cmd: 'echo "start"; sleep 60',
        sessionId,
        tailTimeoutMs: 2000,
      });

      // Verify timeout occurred
      expect(timeoutResult.fail).toBe(true);
      expect(timeoutResult.exitCode).toBe(124);
      expect(timeoutResult.stderr).toBe('Process timed out - no logs received');

      // Second command: should run successfully after session restart
      const successResult = await runtime.exec({
        cmd: 'echo "recovery successful"',
        sessionId,
      });

      // Verify second command executed successfully
      expect(successResult.fail).toBe(false);
      expect(successResult.exitCode).toBe(0);
      expect(successResult.stdout).toContain('recovery successful');
    },
  );

  it(
    'recovers after overall timeout and runs next command successfully',
    { timeout: 15000 },
    async () => {
      // This test verifies that when a command times out due to overall timeout,
      // the session is restarted and the next command can execute successfully
      const sessionId = 'sess-overall-timeout-recovery';

      // First command: will timeout due to overall timeout
      const timeoutPromise = runtime.exec({
        cmd: 'sleep 60',
        sessionId,
        timeoutMs: 2000, // 2 seconds overall timeout
      });

      const timeoutResult = await timeoutPromise;

      // Verify timeout occurred
      expect(timeoutResult.fail).toBe(true);
      expect(timeoutResult.exitCode).toBe(124);
      expect(timeoutResult.stderr).toBe('Process timed out');

      // Second command: should run successfully after session restart
      const successPromise = runtime.exec({
        cmd: 'echo "recovery after overall timeout"',
        sessionId,
      });

      const successResult = await successPromise;

      // Verify second command executed successfully
      expect(successResult.fail).toBe(false);
      expect(successResult.exitCode).toBe(0);
      expect(successResult.stdout).toContain('recovery after overall timeout');
    },
  );

  it(
    'handles multiple commands in queue after timeout',
    { timeout: 20000 },
    async () => {
      // This test verifies that queued commands are properly executed
      // after a session restart due to timeout
      const sessionId = 'sess-queue-recovery';

      // First command: produce output, then stall to trigger tail timeout
      const timeoutPromise = runtime.exec({
        cmd: 'echo "start"; sleep 60',
        sessionId,
        tailTimeoutMs: 1000,
      });

      // Queue second and third commands before timeout resolves
      const secondPromise = runtime.exec({
        cmd: 'echo "second command"',
        sessionId,
      });

      const thirdPromise = runtime.exec({
        cmd: 'echo "third command"',
        sessionId,
      });

      // Wait for all commands to complete
      const [timeoutResult, secondResult, thirdResult] = await Promise.all([
        timeoutPromise,
        secondPromise,
        thirdPromise,
      ]);

      // Verify timeout occurred
      expect(timeoutResult.fail).toBe(true);
      expect(timeoutResult.exitCode).toBe(124);
      expect(timeoutResult.stderr).toBe('Process timed out - no logs received');

      // Verify queued commands executed successfully
      expect(secondResult.fail).toBe(false);
      expect(secondResult.exitCode).toBe(0);
      expect(secondResult.stdout).toContain('second command');

      expect(thirdResult.fail).toBe(false);
      expect(thirdResult.exitCode).toBe(0);
      expect(thirdResult.stdout).toContain('third command');
    },
  );

  it(
    'maintains session state across successful commands after recovery',
    { timeout: 20000 },
    async () => {
      // This test verifies that after a timeout and recovery,
      // the session can maintain state properly
      const sessionId = 'sess-state-recovery';

      // First command: trigger tail timeout to force session restart
      const timeoutResult = await runtime.exec({
        cmd: 'echo "start"; sleep 60',
        sessionId,
        tailTimeoutMs: 1000,
      });
      expect(timeoutResult.fail).toBe(true);
      expect(timeoutResult.exitCode).toBe(124);
      expect(timeoutResult.stderr).toBe('Process timed out - no logs received');

      // Create a file
      const createResult = await runtime.exec({
        cmd: 'echo "test content" > /tmp/test-file.txt',
        sessionId,
      });
      expect(createResult.fail).toBe(false);

      // Set an environment variable
      const envResult = await runtime.exec({
        cmd: 'export TEST_VAR="hello"',
        sessionId,
      });
      expect(envResult.fail).toBe(false);

      // Verify file exists
      const readResult = await runtime.exec({
        cmd: 'cat /tmp/test-file.txt',
        sessionId,
      });
      expect(readResult.fail).toBe(false);
      expect(readResult.stdout).toContain('test content');

      // Verify environment variable (note: export in shell sessions persists in the same session)
      const checkEnvResult = await runtime.exec({
        cmd: 'echo $TEST_VAR',
        sessionId,
      });
      expect(checkEnvResult.fail).toBe(false);
      expect(checkEnvResult.stdout).toContain('hello');
    },
  );

  it(
    'handles abort signal during command execution',
    { timeout: 15000 },
    async () => {
      // This test verifies that abort signals are properly handled
      const sessionId = 'sess-abort-test';
      const abortController = new AbortController();

      // Start a long-running command
      const commandPromise = runtime.exec({
        cmd: 'sleep 60',
        sessionId,
        signal: abortController.signal,
      });

      // Abort after a short delay
      setTimeout(() => {
        abortController.abort();
      }, 500);

      const result = await commandPromise;

      // Verify command was aborted
      expect(result.fail).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toBe('Aborted');

      // Verify next command works
      const nextResult = await runtime.exec({
        cmd: 'echo "after abort"',
        sessionId,
      });

      expect(nextResult.fail).toBe(false);
      expect(nextResult.exitCode).toBe(0);
      expect(nextResult.stdout).toContain('after abort');
    },
  );

  it(
    'handles tailTimeoutMs correctly when command produces output',
    { timeout: 10000 },
    async () => {
      // This test verifies that tailTimeoutMs resets when output is produced
      const sessionId = 'sess-tail-reset';

      // Command that produces output periodically
      // Should not timeout because it keeps producing output
      const result = await runtime.exec({
        cmd: 'for i in 1 2 3; do echo "output $i"; sleep 1; done',
        sessionId,
        tailTimeoutMs: 3000, // tail timeout should not fire while output continues
      });

      expect(result.fail).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('output 1');
      expect(result.stdout).toContain('output 2');
      expect(result.stdout).toContain('output 3');
    },
  );
});
