/**
 * Docker IPC Handlers
 */

import { IPC_CHANNELS } from '@joinery/shared';
import type { DockerStatus, DockerContainer, DockerVolume } from '@joinery/shared';
import { DockerDetector } from '../services/docker/detector';
import { safeHandle } from './safe-handle';

export function registerDockerHandlers(): void {
  const dockerDetector = DockerDetector.getInstance();

  // Detect Docker status
  safeHandle(IPC_CHANNELS.DOCKER.DETECT, async (): Promise<DockerStatus> => {
    const result = await dockerDetector.detect();
    return {
      isAvailable: true, // If we get a response, Docker socket exists
      isRunning: result.dockerRunning,
      error: result.error,
      containers: result.containers,
    };
  });

  // Get SQL Server containers
  safeHandle(IPC_CHANNELS.DOCKER.GET_CONTAINERS, async (): Promise<DockerContainer[]> => {
    const result = await dockerDetector.detect();
    // Add isSqlServer flag and ports array
    return result.containers.map(c => ({
      ...c,
      isSqlServer: true,
      ports: c.port ? [{ internal: 1433, external: c.port }] : [],
    }));
  });

  // Get the named volumes the database containers mount
  safeHandle(IPC_CHANNELS.DOCKER.GET_VOLUMES, async (): Promise<DockerVolume[]> => {
    return dockerDetector.listVolumes();
  });

  // Start a container
  safeHandle(
    IPC_CHANNELS.DOCKER.START_CONTAINER,
    async (_event, containerId: string): Promise<void> => {
      const result = await dockerDetector.startContainer(containerId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to start container');
      }
    }
  );

  // Stop a container
  safeHandle(
    IPC_CHANNELS.DOCKER.STOP_CONTAINER,
    async (_event, containerId: string): Promise<void> => {
      const result = await dockerDetector.stopContainer(containerId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to stop container');
      }
    }
  );

  // Create a new SQL Server container
  safeHandle(
    IPC_CHANNELS.DOCKER.CREATE_CONTAINER,
    async (
      _event,
      options: {
        name: string;
        password: string;
        port: number;
        image?: string;
        acceptEula?: boolean;
      }
    ) => {
      return dockerDetector.createContainer(options);
    }
  );
}
