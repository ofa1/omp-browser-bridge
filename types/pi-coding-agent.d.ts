// Ambient type definitions mirroring @oh-my-pi/pi-coding-agent@18.13.2
declare module "@oh-my-pi/pi-coding-agent" {
  export interface ExtensionUIContext {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, level?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    cwd: string;
    hasUI: boolean;
    [key: string]: unknown;
  }

  export interface ZodType<T = unknown> {
    _output: T;
    optional(): ZodType<T | undefined>;
    default(value: T): this;
    describe(description: string): this;
    [key: string]: unknown;
  }

  export type InferZodShape<T extends Record<string, ZodType<unknown>>> = {
    [K in keyof T]: T[K] extends ZodType<infer O> ? O : unknown;
  };

  export interface ZodString extends ZodType<string> {
    min(len: number, msg?: string): ZodString;
    max(len: number, msg?: string): ZodString;
    regex(pattern: RegExp, msg?: string): ZodString;
  }

  export interface ZodNumber extends ZodType<number> {
    min(value: number, msg?: string): ZodNumber;
    max(value: number, msg?: string): ZodNumber;
    int(msg?: string): ZodNumber;
  }

  export interface ZodArray<T extends ZodType<unknown>> extends ZodType<Array<T extends ZodType<infer O> ? O : unknown>> {
    min(len: number, msg?: string): this;
    max(len: number, msg?: string): this;
  }

  export interface ZodSchemaBuilder {
    object<T extends Record<string, ZodType<unknown>>>(shape: T): ZodType<InferZodShape<T>> & { shape: T };
    string(): ZodString;
    number(): ZodNumber;
    boolean(): ZodType<boolean>;
    enum<const T extends readonly [string, ...string[]]>(values: T): ZodType<T[number]>;
    array<T extends ZodType<unknown>>(element: T): ZodArray<T>;
    record<K extends ZodType<unknown>, V extends ZodType<unknown>>(key: K, value: V): ZodType<Record<string, V extends ZodType<infer O> ? O : unknown>>;
    record<V extends ZodType<unknown>>(value: V): ZodType<Record<string, V extends ZodType<infer O> ? O : unknown>>;
    union<const U extends readonly [ZodType<unknown>, ZodType<unknown>, ...ZodType<unknown>[]]>(schemas: U): ZodType<U[number] extends ZodType<infer O> ? O : unknown>;
    any(): ZodType<unknown>;
    unknown(): ZodType<unknown>;
  }

  export namespace z {
    export type infer<T> = T extends ZodType<infer O> ? O : unknown;
  }

  export type Static<T> = T extends { _output: infer O } ? O : unknown;

  export interface ToolContentItem {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }

  export interface ToolExecutionResult<TDetails = unknown> {
    content: ToolContentItem[];
    details?: TDetails;
  }

  export interface ToolDefinition<TParams = unknown, TDetails = unknown> {
    name: string;
    label: string;
    description: string;
    parameters: TParams;
    defaultInactive?: boolean;
    hidden?: boolean;
    loadMode?: "essential" | "discoverable";
    approval?: "read" | "write" | "exec" | ((args: unknown) => "read" | "write" | "exec");
    execute: (
      toolCallId: string,
      params: Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: ((update: unknown) => void) | undefined,
      ctx: ExtensionContext
    ) => Promise<ToolExecutionResult<TDetails>>;
  }

  export interface ExtensionAPI {
    zod: ZodSchemaBuilder;
    getActiveTools(): Promise<string[]> | string[];
    setActiveTools(toolNames: string[]): Promise<void>;
    registerFlag(name: string, options: {
      description?: string;
      type: "boolean" | "string";
      default?: boolean | string;
    }): void;
    getFlag(name: string): boolean | string | undefined;
    registerCommand(name: string, options: {
      description?: string;
      handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
    }): void;
    registerTool<TParams = unknown, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
  }
}
