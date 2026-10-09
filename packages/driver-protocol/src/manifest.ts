import type { DbObjectKind } from './schema.js';

export const PROTOCOL_VERSION = 1 as const;

export type Transport = 'tcp' | 'socket' | 'file';

export interface EngineDescriptor {
  id: string;
  name: string;
  detect?: 'version-string' | 'query';
}

export interface Capabilities {
  multipleSchemas: boolean;
  transactions: boolean;
  explain: boolean;
  cancel: boolean;
  readOnlySession: boolean;
  objects: DbObjectKind[];
  alterTable: boolean;
  users: boolean;
}

export type FormFieldKind =
  'text' | 'password' | 'number' | 'file' | 'directory' | 'select' | 'checkbox';

export interface FormField {
  key: string;
  label: string;
  kind: FormFieldKind;
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  help?: string;
  /** Show only for these transports. Omitted means always. */
  transports?: Transport[];
  /** Show only when another field has a given value. */
  visibleWhen?: { field: string; equals: string | number | boolean };
  /** For 'file' and 'directory': accepted extensions without dot. */
  extensions?: string[];
}

/** The core renders the connect dialog from this. SSH, color and environment are added by the core. */
export interface FormSchema {
  fields: FormField[];
}

export interface DriverManifest {
  /** Stable id: "mysql", "sqlite", "mssql". Used in connection definitions and URLs. */
  id: string;
  name: string;
  version: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  description?: string;
  homepage?: string;
  license?: string;
  engines: EngineDescriptor[];
  transports: Transport[];
  defaultPort?: number;
  capabilities: Capabilities;
  connectionForm: FormSchema;
  /** File extensions this driver opens directly, for file-based engines. */
  fileExtensions?: string[];
  /** URL schemes the driver understands when a URL is dropped on the app, e.g. "mysql". */
  urlSchemes?: string[];
}
