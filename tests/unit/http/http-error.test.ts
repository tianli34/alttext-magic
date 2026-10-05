/**
 * File: tests/unit/http/http-error.test.ts
 * Purpose: fetch 响应安全解析工具的单元测试。
 *          背景：错误分支无条件 response.json() 时，非 JSON 响应体（鉴权重定向页、
 *          框架 HTML 错误页、隧道错误页）会让浏览器原生 JSON.parse 异常替换真实
 *          错误显示给用户。本测试锁定 extractResponseError / parseJsonResponse 的
 *          行为：JSON 体取 error/message 字段；非 JSON 透出状态码与响应片段；
 *          任何路径都不再抛浏览器原生 JSON.parse 文案。
 */
import { describe, expect, it } from 'vitest';

import {
  extractResponseError,
  parseJsonResponse,
} from '../../../app/lib/http-error';

describe('extractResponseError', () => {
  it('JSON 错误体：优先取 error 字段', async () => {
    const response = new Response(
      JSON.stringify({ error: 'INSUFFICIENT_CREDIT' }),
      { status: 409 },
    );
    await expect(extractResponseError(response)).resolves.toBe('INSUFFICIENT_CREDIT');
  });

  it('JSON 错误体：无 error 时取 message 字段', async () => {
    const response = new Response(JSON.stringify({ message: '额度不足' }), {
      status: 400,
    });
    await expect(extractResponseError(response)).resolves.toBe('额度不足');
  });

  it('JSON 体但无 error/message 字段：退回状态码文案', async () => {
    const response = new Response(JSON.stringify({ code: 'X' }), { status: 500 });
    await expect(extractResponseError(response)).resolves.toBe('请求失败 (500)');
  });

  it('空响应体：仅返回状态码文案', async () => {
    const response = new Response('', { status: 502 });
    await expect(extractResponseError(response)).resolves.toBe('请求失败 (502)');
  });

  it('HTML 错误页：透出状态码与响应片段，不抛 JSON.parse 异常', async () => {
    const response = new Response('<!DOCTYPE html><html><body>500</body></html>', {
      status: 500,
    });
    await expect(extractResponseError(response)).resolves.toBe(
      '请求失败 (500)，响应非 JSON：<!DOCTYPE html><html><body>500</body></html>',
    );
  });

  it('过长的非 JSON 响应体：片段截断到上限', async () => {
    const longText = `x${'a'.repeat(300)}`;
    const response = new Response(longText, { status: 503 });
    const message = await extractResponseError(response);
    expect(message).toMatch(/^请求失败 \(503\)，响应非 JSON：/);
    expect(message.length).toBeLessThan(160);
  });

  it('响应体已被消费（text() 抛异常）：仅返回状态码文案', async () => {
    const response = new Response('{"error":"x"}', { status: 418 });
    await response.text(); // 预先消费掉响应体
    await expect(extractResponseError(response)).resolves.toBe('请求失败 (418)');
  });
});

describe('parseJsonResponse', () => {
  it('合法 JSON 对象：正常解析并保持类型', async () => {
    const response = new Response(JSON.stringify({ batchId: 'b1', totalCount: 3 }), {
      status: 200,
    });
    await expect(
      parseJsonResponse<{ batchId: string; totalCount: number }>(response),
    ).resolves.toEqual({ batchId: 'b1', totalCount: 3 });
  });

  it('合法 JSON 数组：正常解析', async () => {
    const response = new Response('[1,2,3]', { status: 200 });
    await expect(parseJsonResponse<number[]>(response)).resolves.toEqual([1, 2, 3]);
  });

  it('HTML 响应（含鉴权重定向被跟随后拿到 200 页面）：抛可定位错误而非浏览器原生报错', async () => {
    const response = new Response('<!DOCTYPE html><html>login</html>', { status: 200 });
    await expect(parseJsonResponse(response)).rejects.toThrow(
      '响应非 JSON (200)',
    );
  });

  it('空响应体：抛「响应体为空」错误', async () => {
    const response = new Response('', { status: 200 });
    await expect(parseJsonResponse(response)).rejects.toThrow('响应体为空 (200)');
  });

  it('JSON null：合法解析，不误判为失败', async () => {
    const response = new Response('null', { status: 200 });
    await expect(parseJsonResponse<null>(response)).resolves.toBeNull();
  });
});
