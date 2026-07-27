
import * as fs from 'fs';
import TOML from '@ltd/j-toml';
import * as path from 'path';

export function parseFleetConfig(filePath: string): any {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const extension = path.extname(filePath);

  let config;
  if (extension === '.toml') {
    config = TOML.parse(fileContent);
  } else if (extension === '.json') {
    config = JSON.parse(fileContent);
  } else {
    throw new Error(`Unsupported configuration file format: ${extension}`);
  }

  if (config.fleet?.agents && Array.isArray(config.fleet.agents)) {
    for (const agentName of config.fleet.agents) {
      if (!config.agents || !config.agents[agentName]) {
        throw new Error(`Agent "${agentName}" is listed in the fleet but not defined.`);
      }
    }
  }

  return config;
}
