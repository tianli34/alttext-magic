import 'dotenv/config';
import { defineConfig, env } from '@prisma/config';
export default defineConfig({
    schema: 'prisma/schema.prisma',
    datasource: {
        url: env('DATABASE_URL'), // 给 CLI 迁移和内省用的 URL
    },
});
