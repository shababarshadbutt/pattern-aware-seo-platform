import type { Logger } from "@pattern-aware/shared";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

import type { ApiInstance } from "./app.js";
import { OrganizationNotSeededError } from "./org-scope.js";

/**
 * One error shape for the whole API, and nothing leaked into it.
 *
 * Before this existed, every failure took Fastify's default path. Two
 * consequences, both found by probing rather than by reading: a non-UUID path
 * segment produced a 500 whose body contained the **raw SQL query**, column
 * list and all; and `OrganizationNotSeededError` — documented as surfacing
 * "per-request as a clear 503" — produced a generic 500, because nothing
 * mapped it. A comment asserting a guarantee the code does not make is itself
 * a defect (CODING_STANDARDS §1.9).
 *
 * The rule here: a client learns the status and a stable machine-readable
 * code. Anything that might carry internals — a driver message, a query, a
 * stack — is logged server-side and never serialized.
 */

/** A failure the client is allowed to know the details of. */
export class ApiProblem extends Error {
  public override readonly name = "ApiProblem";

  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }

  public static notFound(code: string, message: string): ApiProblem {
    return new ApiProblem(404, code, message);
  }
}

export function registerErrorHandler(app: ApiInstance, logger: Logger): void {
  app.setErrorHandler((error, request, reply) => {
    /**
     * A rejected request body/params. Reported field by field, because
     * "invalid request" without naming the field is a support ticket.
     */
    if (hasZodFastifySchemaValidationErrors(error)) {
      const detail = error.validation
        .map((issue) => {
          const path =
            issue.instancePath === "" ? "(root)" : issue.instancePath;

          return `${path}: ${issue.message ?? "invalid"}`;
        })
        .join("; ");

      void reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: detail }
      });

      return;
    }

    if (error instanceof OrganizationNotSeededError) {
      /**
       * 503, not 500: the service is fine, its data is not there yet. The
       * message is the actionable one, since this is what a developer hits on
       * a fresh checkout.
       */
      logger.error({ err: error }, "organization not seeded");

      void reply.code(503).send({
        error: {
          code: "ORGANIZATION_NOT_SEEDED",
          message: `${error.message} Run "pnpm seed:demo" to create it.`
        }
      });

      return;
    }

    if (error instanceof ApiProblem) {
      void reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message }
      });

      return;
    }

    /**
     * Anything else is a bug or a dependency failure. Logged in full with the
     * request that caused it; the client gets a status and nothing else.
     */
    logger.error(
      {
        err: error,
        method: request.method,
        url: request.url
      },
      "unhandled error serving request"
    );

    void reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed."
      }
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        code: "ROUTE_NOT_FOUND",
        message: `No route for ${request.method} ${request.url}`
      }
    });
  });
}
