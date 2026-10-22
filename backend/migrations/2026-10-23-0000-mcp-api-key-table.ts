import { Knex } from "knex";

export async function up(knex : Knex) : Promise<void> {
    return knex.schema.createTable("mcp_api_key", (table) => {
        table.increments("id");
        table.integer("user_id").unsigned().notNullable().references("id").inTable("user").onDelete("CASCADE");
        table.string("name", 100).notNullable();
        table.string("key_hash", 64).notNullable().unique();
        table.text("scopes").notNullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("expires_at").notNullable();
        table.bigInteger("revoked_at").nullable();
        table.index("user_id");
    });
}

export async function down(knex : Knex) : Promise<void> {
    return knex.schema.dropTable("mcp_api_key");
}
