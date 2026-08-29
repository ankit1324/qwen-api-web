import * as fs from 'fs';
import * as path from 'path';

export interface Config {
  port: number;
  token: string | null;
  api_keys: string[];
}

export const DEFAULT_CONFIG: Config = {
  port: 8081,
  token: null,
  api_keys: [],
};

export function parseConfig(data: Partial<Config>): Config {
  return { ...DEFAULT_CONFIG, ...data };
}

export function getConfig(): Config {
  let jsonConfig: Partial<Config> = {};
  const configPath = path.resolve(process.cwd(), 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      jsonConfig = JSON.parse(content);
    } catch (e) {
      console.warn('Failed to parse config.json, using defaults.');
    }
  }
  
  const token = process.env.QWEN_TOKEN || jsonConfig.token || null;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : (jsonConfig.port || DEFAULT_CONFIG.port);
  const api_keys = jsonConfig.api_keys || DEFAULT_CONFIG.api_keys;

  return { port, token, api_keys };
}