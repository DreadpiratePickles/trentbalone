// VENDORED CODE - DO NOT EDIT BY HAND.
//
// Source:  @prisma/adapter-better-sqlite3
// Version: 6.19.3   (must match the `prisma` / `@prisma/client` version in
//                    packages/trent-core/package.json)
// Files:   dist/index.mjs -> src/conversion.ts and src/errors.ts
//
// Why vendored: there is no official bun:sqlite driver adapter. Rather than re-derive the
// value coercions (a silent coercion bug surfaces as wrong data, not as a crash) we lift
// Prisma's own helpers verbatim and drive them from bun:sqlite in bun-sqlite-adapter.mjs.
//
// ON EVERY PRISMA UPGRADE: diff this file against the new
// node_modules/@prisma/adapter-better-sqlite3/dist/index.mjs and re-run
// `npx vitest run packages/trent-core/src/store`. Bump the version stamp above.

import { ColumnTypeEnum, Debug } from "@prisma/driver-adapter-utils";

const debug = Debug("prisma:driver-adapter:bun-sqlite:conversion");

function mapDeclType(declType) {
  if (declType === null) {
    return null;
  }
  switch (declType.toUpperCase()) {
    case "":
      return null;
    case "DECIMAL":
      return ColumnTypeEnum.Numeric;
    case "FLOAT":
      return ColumnTypeEnum.Float;
    case "DOUBLE":
    case "DOUBLE PRECISION":
    case "NUMERIC":
    case "REAL":
      return ColumnTypeEnum.Double;
    case "TINYINT":
    case "SMALLINT":
    case "MEDIUMINT":
    case "INT":
    case "INTEGER":
    case "SERIAL":
    case "INT2":
      return ColumnTypeEnum.Int32;
    case "BIGINT":
    case "UNSIGNED BIG INT":
    case "INT8":
      return ColumnTypeEnum.Int64;
    case "DATETIME":
    case "TIMESTAMP":
      return ColumnTypeEnum.DateTime;
    case "TIME":
      return ColumnTypeEnum.Time;
    case "DATE":
      return ColumnTypeEnum.Date;
    case "TEXT":
    case "CLOB":
    case "CHARACTER":
    case "VARCHAR":
    case "VARYING CHARACTER":
    case "NCHAR":
    case "NATIVE CHARACTER":
    case "NVARCHAR":
      return ColumnTypeEnum.Text;
    case "BLOB":
      return ColumnTypeEnum.Bytes;
    case "BOOLEAN":
      return ColumnTypeEnum.Boolean;
    case "JSONB":
      return ColumnTypeEnum.Json;
    default:
      debug("unknown decltype:", declType);
      return null;
  }
}

function mapDeclaredColumnTypes(columnTypes) {
  const emptyIndices = new Set();
  const result = columnTypes.map((typeName, index) => {
    const mappedType = mapDeclType(typeName);
    if (mappedType === null) {
      emptyIndices.add(index);
    }
    return mappedType;
  });
  return [result, emptyIndices];
}

export function getColumnTypes(declaredTypes, rows) {
  const [columnTypes, emptyIndices] = mapDeclaredColumnTypes(declaredTypes);
  if (emptyIndices.size === 0) {
    return columnTypes;
  }
  columnLoop: for (const columnIndex of emptyIndices) {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const candidateValue = rows[rowIndex][columnIndex];
      if (candidateValue !== null) {
        columnTypes[columnIndex] = inferColumnType(candidateValue);
        continue columnLoop;
      }
    }
    columnTypes[columnIndex] = ColumnTypeEnum.Int32;
  }
  return columnTypes;
}

function inferColumnType(value) {
  switch (typeof value) {
    case "string":
      return ColumnTypeEnum.Text;
    case "bigint":
      return ColumnTypeEnum.Int64;
    case "boolean":
      return ColumnTypeEnum.Boolean;
    case "number":
      return ColumnTypeEnum.UnknownNumber;
    case "object":
      return inferObjectType(value);
    default:
      throw new UnexpectedTypeError(value);
  }
}

function inferObjectType(value) {
  if (value instanceof ArrayBuffer) {
    return ColumnTypeEnum.Bytes;
  }
  throw new UnexpectedTypeError(value);
}

class UnexpectedTypeError extends Error {
  name = "UnexpectedTypeError";
  constructor(value) {
    const type = typeof value;
    const repr = type === "object" ? JSON.stringify(value) : String(value);
    super(`unexpected value of type ${type}: ${repr}`);
  }
}

export function mapRow(row, columnTypes) {
  const result = [];
  for (let i = 0; i < row.length; i++) {
    const value = row[i];
    if (value instanceof ArrayBuffer || value instanceof Buffer) {
      result[i] = Array.from(new Uint8Array(value));
      continue;
    }
    if (
      typeof value === "number" &&
      (columnTypes[i] === ColumnTypeEnum.Int32 || columnTypes[i] === ColumnTypeEnum.Int64) &&
      !Number.isInteger(value)
    ) {
      result[i] = Math.trunc(value);
      continue;
    }
    if (["number", "bigint"].includes(typeof value) && columnTypes[i] === ColumnTypeEnum.DateTime) {
      result[i] = new Date(Number(value)).toISOString();
      continue;
    }
    if (typeof value === "bigint") {
      result[i] = value.toString();
      continue;
    }
    result[i] = value;
  }
  return result;
}

export function mapArg(arg, argType, options) {
  if (arg === null) {
    return null;
  }
  if (typeof arg === "string" && argType.scalarType === "int") {
    return Number.parseInt(arg);
  }
  if (typeof arg === "string" && argType.scalarType === "float") {
    return Number.parseFloat(arg);
  }
  if (typeof arg === "string" && argType.scalarType === "decimal") {
    return Number.parseFloat(arg);
  }
  if (typeof arg === "string" && argType.scalarType === "bigint") {
    return BigInt(arg);
  }
  if (typeof arg === "boolean") {
    return arg ? 1 : 0;
  }
  if (typeof arg === "string" && argType.scalarType === "datetime") {
    arg = new Date(arg);
  }
  if (arg instanceof Date) {
    const format = options?.timestampFormat ?? "iso8601";
    switch (format) {
      case "unixepoch-ms":
        return arg.getTime();
      case "iso8601":
        return arg.toISOString().replace("Z", "+00:00");
      default:
        throw new Error(`Unknown timestamp format: ${format}`);
    }
  }
  if (typeof arg === "string" && argType.scalarType === "bytes") {
    return Buffer.from(arg, "base64");
  }
  if (Array.isArray(arg) && argType.scalarType === "bytes") {
    return Buffer.from(arg);
  }
  return arg;
}

export function convertDriverError(error) {
  if (isDriverError(error)) {
    return {
      originalCode: error.code,
      originalMessage: error.message,
      ...mapDriverError(error),
    };
  }
  throw error;
}

function mapDriverError(error) {
  switch (error.code) {
    case "SQLITE_BUSY":
      return { kind: "SocketTimeout" };
    case "SQLITE_CONSTRAINT_UNIQUE":
    case "SQLITE_CONSTRAINT_PRIMARYKEY": {
      const fields = error.message
        .split("constraint failed: ")
        .at(1)
        ?.split(", ")
        .map((field) => field.split(".").pop());
      return {
        kind: "UniqueConstraintViolation",
        constraint: fields !== undefined ? { fields } : undefined,
      };
    }
    case "SQLITE_CONSTRAINT_NOTNULL": {
      const fields = error.message
        .split("constraint failed: ")
        .at(1)
        ?.split(", ")
        .map((field) => field.split(".").pop());
      return {
        kind: "NullConstraintViolation",
        constraint: fields !== undefined ? { fields } : undefined,
      };
    }
    case "SQLITE_CONSTRAINT_FOREIGNKEY":
    case "SQLITE_CONSTRAINT_TRIGGER":
      return { kind: "ForeignKeyConstraintViolation", constraint: { foreignKey: {} } };
    default:
      if (error.message.startsWith("no such table")) {
        return { kind: "TableDoesNotExist", table: error.message.split(": ").at(1) };
      } else if (error.message.startsWith("no such column")) {
        return { kind: "ColumnNotFound", column: error.message.split(": ").at(1) };
      } else if (error.message.includes("has no column named ")) {
        return { kind: "ColumnNotFound", column: error.message.split("has no column named ").at(1) };
      }
      throw error;
  }
}

function isDriverError(error) {
  return typeof error.code === "string" && typeof error.message === "string";
}
