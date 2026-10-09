import { utilityProcess, type UtilityProcess } from 'electron';
import { DriverClient, electronUtilityProcessTransport } from '@rasql/driver-sdk';
import { findDriver } from './registry';

/** One driver process, wrapped in a protocol client. Dies with its connection. */
export class DriverProcess {
  private constructor(
    readonly driverId: string,
    private readonly child: UtilityProcess,
    readonly client: DriverClient,
  ) {}

  static async spawn(driverId: string, onLog: (line: string) => void): Promise<DriverProcess> {
    const { entry } = findDriver(driverId);
    const child = utilityProcess.fork(entry, [], {
      serviceName: `rasql-driver-${driverId}`,
      stdio: 'pipe',
    });
    child.stdout?.on('data', (d: Buffer) => onLog(`[${driverId}] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => onLog(`[${driverId}!] ${d.toString().trimEnd()}`));
    const client = new DriverClient(electronUtilityProcessTransport(child), {
      onLog: (level, message) => onLog(`[${driverId} ${level}] ${message}`),
    });
    child.once('exit', (code) => onLog(`[${driverId}] process exited with code ${code}`));
    await client.ready;
    return new DriverProcess(driverId, child, client);
  }

  kill(): void {
    this.client.shutdown();
    this.child.kill();
  }
}
