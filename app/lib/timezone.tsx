/**
 * File: app/lib/timezone.tsx
 * Purpose: 店铺时区 React Context，全局提供时区信息供时间格式化使用。
 */

import { createContext, useContext } from "react";

const TimezoneContext = createContext<string>("UTC");

export function TimezoneProvider({
  timezone,
  children,
}: {
  timezone: string | null;
  children: React.ReactNode;
}) {
  const resolved = timezone ?? "UTC";
  return (
    <TimezoneContext.Provider value={resolved}>
      {children}
    </TimezoneContext.Provider>
  );
}

export function useTimezone(): string {
  return useContext(TimezoneContext);
}
