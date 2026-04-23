---
name: prisma-query
description: 当需要了解数据库结构时，使用此技能查询 Prisma Schema 的 model 定义、字段类型、enum 值及模型间关联关系。
---

## Target file
- `prisma/schema.prisma`

## How to run
在项目根目录执行 `pq` 命令。

## Commands
model <Name...> 查看单个或多个 Model 定义
enum <Name...> 查看单个或多个 Enum 定义
context <Name> [--depth <n>] 查看 Model 及其关联上下文（默认 depth=1）
field <Model> <Field> 查看字段详细信息
field --attr '<@attribute>' 查找所有含指定属性的字段
search <keyword> 全局搜索 Model/字段/类型
models 列出所有 Model

## Examples
pq model User
pq model User Post Comment
pq enum Role
pq context Post
pq context Post --depth 2
pq field User email
pq field --attr '@unique'
pq field --attr '@relation'
pq search userId
pq models
