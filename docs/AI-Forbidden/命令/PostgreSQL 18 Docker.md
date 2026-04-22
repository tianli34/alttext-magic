# 备份数据库
docker exec my-postgres18 pg_dump -U myuser mydatabase > backup.sql

# 恢复数据库
docker exec -i my-postgres18 psql -U myuser -d mydatabase < backup.sql

# 使用 pg_dumpall 备份所有数据库
docker exec my-postgres18 pg_dumpall -U myuser > all_databases.sql

# 启动容器（后台运行）
docker compose up -d

# 查看容器状态
docker compose ps

# 查看日志
docker compose logs -f db

# 停止容器
docker compose stop

# 完全停止并删除容器（保留数据卷）
docker compose down

# 停止并删除容器及数据卷（⚠️ 清空所有数据）
docker compose down -v


# 进入 PostgreSQL 命令行
docker exec -it my-postgres18 psql -U myuser -d mydatabase

# 进入容器 Bash
docker exec -it my-postgres18 bash

# 以 postgres 用户身份进入
docker exec -it -u postgres my-postgres18 bash


# 列出所有数据库
docker exec my-postgres18 psql -U myuser -c "\l"

# 列出所有表
docker exec my-postgres18 psql -U myuser -d mydatabase -c "\dt"

# 查看表结构
docker exec my-postgres18 psql -U myuser -d mydatabase -c "\d 表名"

# 执行 SQL 查询
docker exec my-postgres18 psql -U myuser -d mydatabase -c "SELECT * FROM 表名 LIMIT 10;"


# 本地连接
postgresql://myuser:mypassword@localhost:5432/mydatabase

# 容器内连接
postgresql://myuser:mypassword@db:5432/mydatabase


# 使用 psql 客户端连接
psql postgresql://myuser:mypassword@localhost:5432/mydatabase

# 使用 Docker 测试
docker run --rm -it postgres:18 psql postgresql://myuser:mypassword@host.docker.internal:5432/mydatabase


