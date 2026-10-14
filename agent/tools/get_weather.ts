import { defineTool } from "eve/tools";
import { z } from "zod";

/** 离线占位实现：按城市名做哈希，返回稳定的假天气。接真实天气 API 时替换这里。 */
function stubWeather(city: string) {
  let hash = 0;
  for (const char of city) {
    hash = (hash * 31 + char.codePointAt(0)!) % 1_000_003;
  }

  const conditions = ["晴", "多云", "阴", "小雨", "雷阵雨"] as const;
  return {
    condition: conditions[hash % conditions.length],
    temperatureC: 8 + (hash % 25),
    humidityPercent: 30 + (hash % 60),
  };
}

export default defineTool({
  description: "查询某个城市的当前天气。这是一个离线占位实现，用来演示工具调用，数据不是真实的。",
  inputSchema: z.object({
    city: z.string().min(1).describe("城市名，例如 北京"),
  }),
  label: {
    start: ({ city }) => `查询 ${city} 天气`,
  },
  async execute({ city }) {
    return { city, ...stubWeather(city), source: "stub" };
  },
});
