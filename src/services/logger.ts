/** The methods the application uses; a pino logger satisfies it as is. */
export interface Logger {
  info(fields: Record<string, unknown>, event: string): void;
  warn(fields: Record<string, unknown>, event: string): void;
  error(fields: Record<string, unknown>, event: string): void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
