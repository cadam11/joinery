/**
 * Docker Detector Service
 * Detects SQL Server containers running in Docker
 */

import Dockerode from 'dockerode';
import type {
  DockerContainer,
  DockerVolume,
  DockerVolumeMapping,
  DockerDetectionResult,
  StartContainerResult,
  PathTranslation,
  ContainerState,
} from '@joinery/shared';
import { BaseSingleton } from '../../utils/singleton';
import { resolveDockerFixture } from './docker-fixture';

export class DockerDetector extends BaseSingleton {
  private docker: Dockerode;

  constructor() {
    super();
    this.docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
  }

  /**
   * Check if Docker is running
   */
  async isDockerRunning(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect SQL Server containers
   *
   * A launch may pin the answer instead (J-76) — see `docker-fixture.ts` for why a screenshot of
   * this panel is otherwise a screenshot of the host's `docker ps`. Read ABOVE the try, so a
   * malformed fixture rejects the channel with its own message rather than being folded into the
   * "Docker is not running" result the catch below produces for a dead daemon.
   */
  async detect(): Promise<DockerDetectionResult> {
    const fixture = resolveDockerFixture();
    if (fixture !== null) return fixture.detect;

    try {
      const isRunning = await this.isDockerRunning();

      if (!isRunning) {
        return {
          dockerRunning: false,
          containers: [],
          error: 'Docker is not running. Please start Docker Desktop.',
        };
      }

      const containers = await this.docker.listContainers({ all: true });
      const sqlContainers: DockerContainer[] = [];

      for (const container of containers) {
        const engine = databaseEngineOf(container.Image);

        if (engine) {
          const portBinding = container.Ports.find(p => p.PrivatePort === ENGINE_PORTS[engine]);

          const volumeMappings: DockerVolumeMapping[] = (container.Mounts || [])
            .filter(m => m.Type === 'bind')
            .map(m => ({
              hostPath: m.Source || '',
              containerPath: m.Destination || '',
              mode: (m.Mode || 'rw') as 'rw' | 'ro',
            }));

          sqlContainers.push({
            id: container.Id,
            name: container.Names[0]?.replace(/^\//, '') || 'unknown',
            image: container.Image,
            state: container.State as ContainerState,
            status: container.Status,
            port: portBinding?.PublicPort || null,
            hostBinding: portBinding?.IP || '0.0.0.0',
            volumeMappings,
            created: new Date(container.Created * 1000).toISOString(),
          });
        }
      }

      return {
        dockerRunning: true,
        containers: sqlContainers,
      };
    } catch (error) {
      return {
        dockerRunning: false,
        containers: [],
        error: error instanceof Error ? error.message : 'Failed to detect Docker containers',
      };
    }
  }

  /**
   * Get volume mappings for a specific container
   */
  async getVolumeMappings(containerId: string): Promise<DockerVolumeMapping[]> {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();

      return (info.Mounts || [])
        .filter(m => m.Type === 'bind')
        .map(m => ({
          hostPath: m.Source || '',
          containerPath: m.Destination || '',
          mode: (m.Mode || 'rw') as 'rw' | 'ro',
        }));
    } catch {
      return [];
    }
  }

  /**
   * The named volumes the database containers mount.
   *
   * Filtered to the containers `detect()` keeps, rather than every volume on the machine: the
   * panel lists these underneath the database containers, and a development box accumulates
   * dozens of unrelated (often dangling) volumes that would drown the section. `Name` is set only
   * on `Type: 'volume'` mounts, so a bind mount contributes nothing here — those are already
   * reported per container as `volumeMappings`.
   *
   * Rejects when the daemon does, rather than answering `[]`: the caller's channel logs and
   * re-throws, and the renderer only asks once `detect()` has said Docker is running.
   *
   * Pinned alongside `detect()` when a launch pins a fixture (J-76): the panel renders this list
   * under the container rows, so a deterministic row set with a host-dependent Volumes section
   * would leave the surface exactly as unbaselineable as before.
   */
  async listVolumes(): Promise<DockerVolume[]> {
    const fixture = resolveDockerFixture();
    if (fixture !== null) return [...fixture.volumes];

    const [listed, containers] = await Promise.all([
      this.docker.listVolumes(),
      this.docker.listContainers({ all: true }),
    ]);

    const mounted = new Set(
      containers
        .filter(c => databaseEngineOf(c.Image) !== null)
        .flatMap(c => c.Mounts || [])
        .filter(m => m.Type === 'volume')
        .map(m => m.Name)
        .filter((name): name is string => typeof name === 'string')
    );

    return (listed.Volumes || [])
      .filter(v => mounted.has(v.Name))
      .map(v => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint }));
  }

  /**
   * Start a stopped container
   */
  async startContainer(containerId: string): Promise<StartContainerResult> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.start();

      return {
        success: true,
        containerId,
      };
    } catch (error) {
      return {
        success: false,
        containerId,
        error: error instanceof Error ? error.message : 'Failed to start container',
      };
    }
  }

  /**
   * Stop a running container
   */
  async stopContainer(containerId: string): Promise<StartContainerResult> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop();

      return {
        success: true,
        containerId,
      };
    } catch (error) {
      return {
        success: false,
        containerId,
        error: error instanceof Error ? error.message : 'Failed to stop container',
      };
    }
  }

  /**
   * Create a new SQL Server container
   */
  async createContainer(options: {
    name: string;
    password: string;
    port: number;
    image?: string;
    acceptEula?: boolean;
  }): Promise<StartContainerResult> {
    try {
      const image = options.image || 'mcr.microsoft.com/mssql/server:2022-latest';

      // Pull image if not available
      try {
        await this.docker.getImage(image).inspect();
      } catch {
        // Image not found, pull it
        const stream = await this.docker.pull(image);
        // Wait for pull to complete
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      const container = await this.docker.createContainer({
        Image: image,
        name: options.name,
        Env: [
          options.acceptEula !== false ? 'ACCEPT_EULA=Y' : '',
          `MSSQL_SA_PASSWORD=${options.password}`,
        ].filter(Boolean),
        HostConfig: {
          PortBindings: {
            '1433/tcp': [{ HostPort: String(options.port) }],
          },
        },
        ExposedPorts: {
          '1433/tcp': {},
        },
      });

      await container.start();

      return {
        success: true,
        containerId: container.id,
      };
    } catch (error) {
      return {
        success: false,
        containerId: '',
        error: error instanceof Error ? error.message : 'Failed to create container',
      };
    }
  }

  /**
   * Translate a local path to a container path using volume mappings
   */
  translatePath(localPath: string, mappings: DockerVolumeMapping[]): PathTranslation {
    // Normalize path separators
    const normalizedLocal = localPath.replace(/\\/g, '/');

    for (const mapping of mappings) {
      const normalizedHost = mapping.hostPath.replace(/\\/g, '/');

      if (normalizedLocal.startsWith(normalizedHost)) {
        const relativePath = normalizedLocal.slice(normalizedHost.length);
        const containerPath = mapping.containerPath + relativePath;

        return {
          localPath,
          containerPath,
          isAccessible: true,
        };
      }
    }

    // Path is not mapped
    return {
      localPath,
      containerPath: localPath,
      isAccessible: false,
      suggestion: `Mount the directory as a volume. Example: -v "${localPath}:/var/opt/mssql/backups"`,
    };
  }

  /**
   * Get default backup path in container based on database engine
   */
  getDefaultBackupPath(engine: string = 'mssql'): string {
    if (engine === 'postgresql') return '/var/lib/postgresql/backups';
    if (engine === 'mysql') return '/var/lib/mysql/backups';
    return '/var/opt/mssql/backups';
  }

  /**
   * Get default data path in container based on database engine
   */
  getDefaultDataPath(engine: string = 'mssql'): string {
    if (engine === 'postgresql') return '/var/lib/postgresql/data';
    if (engine === 'mysql') return '/var/lib/mysql';
    return '/var/opt/mssql/data';
  }
}

type DatabaseEngine = 'mssql' | 'postgresql' | 'mysql';

/** The port each engine listens on inside its container. */
const ENGINE_PORTS: Record<DatabaseEngine, number> = {
  mssql: 1433,
  postgresql: 5432,
  mysql: 3306,
};

/**
 * Which database engine an image is, or `null` for an image that is not one.
 *
 * Lifted out of `detect()` so `listVolumes()` decides "is this a database container" by exactly
 * the same test rather than a second copy of it. The order matters and is the order `detect()`
 * used to resolve its default port with: an image naming two engines is read as the earlier one.
 */
function databaseEngineOf(image: string): DatabaseEngine | null {
  const lower = image.toLowerCase();
  if (lower.includes('postgres') || lower.includes('postgresql') || lower.includes('postgis')) {
    return 'postgresql';
  }
  if (lower.includes('mysql') || lower.includes('mariadb')) return 'mysql';
  if (lower.includes('mssql') || lower.includes('sqlserver') || lower.includes('azure-sql-edge')) {
    return 'mssql';
  }
  return null;
}
