import pc from "picocolors";

let verbose = false;

export const logger = {
  setVerbose(value: boolean): void {
    verbose = value;
  },
  info(message: string): void {
    console.log(pc.cyan(message));
  },
  warn(message: string): void {
    console.warn(pc.yellow(message));
  },
  error(message: string): void {
    console.error(pc.red(message));
  },
  success(message: string): void {
    console.log(pc.green(message));
  },
  step(message: string): void {
    if (verbose) console.log(pc.dim(message));
  },
};

export const setVerbose = (value: boolean): void => logger.setVerbose(value);
export const info = (message: string): void => logger.info(message);
export const warn = (message: string): void => logger.warn(message);
export const error = (message: string): void => logger.error(message);
export const success = (message: string): void => logger.success(message);
export const step = (message: string): void => logger.step(message);
