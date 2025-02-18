#include <Arduino.h>
#include <WiFi.h>

void setup() {
    Serial.begin(9600);
    
    // Get ESP32's MAC address
    String macAddress = WiFi.macAddress();
    
    Serial.print("ESP32 MAC Address: ");
    Serial.println(macAddress);
}

void loop() {
    // Do nothing
}
