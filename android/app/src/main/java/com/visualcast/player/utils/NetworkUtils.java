package com.visualcast.player.utils;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class NetworkUtils {

    /**
     * 获取设备当前的局域网 IPv4 地址 (优先有线网络 eth0，其次无线网络 wlan0)
     */
    public static String getLocalIpAddress() {
        List<Map<String, Object>> list = getNetworkInterfaces();
        if (!list.isEmpty()) {
            return (String) list.get(0).get("ip");
        }
        return "127.0.0.1";
    }

    /**
     * 深度枚举当前设备所有可用物理与无线网卡及对应 IPv4
     */
    public static List<Map<String, Object>> getNetworkInterfaces() {
        List<Map<String, Object>> result = new ArrayList<>();
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface intf : interfaces) {
                if (intf.isLoopback() || !intf.isUp()) continue;
                List<InetAddress> addrs = Collections.list(intf.getInetAddresses());
                for (InetAddress addr : addrs) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                        String ip = addr.getHostAddress();
                        if (ip != null && !ip.isEmpty() && !ip.startsWith("127.") && !ip.startsWith("169.254.")) {
                            String name = intf.getName();
                            String nameLower = name.toLowerCase();
                            String type = "other";
                            String prefix = "[网络连接]";
                            boolean isEthernet = nameLower.contains("eth");
                            boolean isWifi = nameLower.contains("wlan") || nameLower.contains("wifi");

                            if (isEthernet) {
                                type = "ethernet";
                                prefix = "[有线网络]";
                            } else if (isWifi) {
                                type = "wifi";
                                prefix = "[无线网络]";
                            }

                            Map<String, Object> map = new HashMap<>();
                            map.put("name", name);
                            map.put("display_name", prefix + ": " + name + " (" + ip + ")");
                            map.put("ip", ip);
                            map.put("type", type);
                            map.put("is_primary", isEthernet);

                            // 有线排在最前
                            if (isEthernet) {
                                result.add(0, map);
                            } else {
                                result.add(map);
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {}

        if (result.isEmpty()) {
            Map<String, Object> map = new HashMap<>();
            map.put("name", "loopback");
            map.put("display_name", "[本机回环]: 127.0.0.1");
            map.put("ip", "127.0.0.1");
            map.put("type", "loopback");
            map.put("is_primary", true);
            result.add(map);
        }
        return result;
    }
}

