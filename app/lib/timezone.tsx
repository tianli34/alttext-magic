/**
 * File: app/lib/timezone.tsx
 * Purpose: 店铺时区 React Context，全局提供时区信息供时间格式化使用。
 */

import { createContext, useContext } from "react";

const TimezoneContext = createContext<string>("Asia/Shanghai");

export function TimezoneProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: React.ReactNode;
}) {
  return (
    <TimezoneContext.Provider value={timezone}>
      {children}
    </TimezoneContext.Provider>
  );
}

export function useTimezone(): string {
  return useContext(TimezoneContext);
}
