import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authenticatedUser } from "../route-helpers/session.js";

type Deps = { pool: Pool };
type CommandStatusRow = {
  id: string;
  command_type: string;
  status: string;
  failure_code: string | null;
};

export function registerProviderCommandRoutes(app: FastifyInstance<any, any, any, any>, { pool }: Deps) {
  app.get<{ Params: { mailboxId: string; commandId: string } }>("/v1/mailboxes/:mailboxId/provider-commands/:commandId", async (request, reply) => {
    const user = await authenticatedUser(request, pool);
    if (!user) return reply.code(401).send({ code: "unauthenticated", message: "Sign in to view command status." });

    const result = await pool.query<CommandStatusRow>(
      "SELECT c.id,c.command_type,c.status,c.failure_code FROM provider_commands c JOIN mailbox_accounts m ON m.id=c.mailbox_account_id WHERE c.id=$1 AND c.mailbox_account_id=$2 AND m.user_id=$3",
      [request.params.commandId, request.params.mailboxId, user.id]
    );
    if (!result.rowCount) return reply.code(404).send({ code: "provider_command_not_found", message: "Command not found." });

    const command = result.rows[0];
    return { id: command.id, commandType: command.command_type, status: command.status, failureCode: command.failure_code };
  });
}
