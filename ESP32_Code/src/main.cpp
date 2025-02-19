#include <Arduino.h>
#include <WiFi.h>

void setup() {
    Serial.begin(115200);
    WiFi.mode(WIFI_MODE_STA);
}

void loop() {
    // Do nothing
    // Get ESP32's MAC address
    String macAddress = WiFi.macAddress();
    
    Serial.print("ESP32 MAC Address: ");
    Serial.println(macAddress);
    delay(2000);
}
