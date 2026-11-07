// The one definition of a valid GitHub host name (config key `github.host` and `--host`). A host is
// placed in argv and printed in commands: it must not be able to look like a flag.

export const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:\d{1,5})?$/;
