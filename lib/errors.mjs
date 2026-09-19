// Exit codes are part of the CLI contract, so the error carries one.
export const EXIT = {
  error: 1,
  timeout: 2,
  unreachable: 3,
};

export class CdpError extends Error {
  constructor(message, code = EXIT.error) {
    super(message);
    this.name = "CdpError";
    this.code = code;
  }
}
