// #include <Arduino.h>
// #include <WiFi.h>

// void setup() {
//     Serial.begin(115200);
//     WiFi.mode(WIFI_MODE_STA);
// }

// void loop() {
//     // Do nothing
//     // Get ESP32's MAC address
//     String macAddress = WiFi.macAddress();
    
//     Serial.print("ESP32 MAC Address: ");
//     Serial.println(macAddress);
//     delay(2000);
// }

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>

// Replace with your WiFi credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// Replace with your IoT server's IP and port
const char* server_url = "http://YOUR_SERVER_IP:3000";

// MQTT Credentials (To be received from the server)
String mqtt_broker;
int mqtt_port;
String mqtt_username;
String mqtt_password;
String pub_topic;
String sub_topic;

// Token for authentication
String jwt_token;

// ESP32 MAC Address
String getMacAddress() {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char macStr[18];
    sprintf(macStr, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return String(macStr);
}

// Function to send HTTP POST request
String sendHttpPost(const String& endpoint, const String& payload) {
    HTTPClient http;
    WiFiClientSecure client;
    client.setInsecure(); // For development; use certificates in production

    String fullUrl = String(server_url) + endpoint;
    http.begin(client, fullUrl);
    http.addHeader("Content-Type", "application/json");

    if (jwt_token != "") {
        http.addHeader("Authorization", "Bearer " + jwt_token);
    }

    int httpResponseCode = http.POST(payload);
    String response = "";

    if (httpResponseCode > 0) {
        response = http.getString();
    } else {
        Serial.printf("HTTP Request failed! Error: %s\n", http.errorToString(httpResponseCode).c_str());
    }

    http.end();
    return response;
}

// Function to validate the device
bool validateDevice() {
    String mac = getMacAddress();
    String payload = "{\"mac_address\":\"" + mac + "\"}";

    Serial.println("Validating device...");
    String response = sendHttpPost("/api/validate", payload);

    if (response.indexOf("Device validated") != -1) {
        // Extract JWT Token
        DynamicJsonDocument doc(512);
        deserializeJson(doc, response);
        jwt_token = doc["token"].as<String>();
        Serial.println("Device is validated. Token received.");
        return true;    
    } else if (response.indexOf("Device not registered") != -1) {
        Serial.println("Device not registered. Registering now...");
        return false;
    }

    return false;
}

// Function to register the device
bool registerDevice() {
    String mac = getMacAddress();
    String payload = "{\"mac_address\":\"" + mac + "\"}";

    Serial.println("Registering device...");
    String response = sendHttpPost("/api/register", payload);

    DynamicJsonDocument doc(512);
    deserializeJson(doc, response);

    if (response.indexOf("Device registered successfully") != -1) {
        mqtt_username = doc["mqtt_username"].as<String>();
        mqtt_password = doc["mqtt_password"].as<String>();
        Serial.println("Device registered successfully.");
        return true;
    }   

    Serial.println("Device registration failed.");
    return false;
}

// Function to get MQTT info from the server
bool getMqttInfo() {
    Serial.println("Getting MQTT information...");

    String fullUrl = String(server_url) + "/api/get-mqtt-info?username=" + mqtt_username;
    HTTPClient http;
    WiFiClientSecure client;
    client.setInsecure();

    http.begin(client, fullUrl);
    http.addHeader("Authorization", "Bearer " + jwt_token);

    int httpResponseCode = http.GET();
    String response = "";

    if (httpResponseCode > 0) {
    response = http.getString();
    } else {
        Serial.printf("Failed to get MQTT info. Error: %s\n", http.errorToString(httpResponseCode).c_str());
        return false;
    }

    http.end();

    DynamicJsonDocument doc(512);
    deserializeJson(doc, response);

    if (response.indexOf("MQTT information retrieved successfully") != -1) {
        mqtt_broker = doc["mqttInfo"]["broker_ip"].as<String>();
        mqtt_port = doc["mqttInfo"]["port"].as<int>();
        pub_topic = doc["mqttInfo"]["topics"][0].as<String>();
        sub_topic = doc["mqttInfo"]["topics"][1].as<String>();

        Serial.println("MQTT information received successfully.");
        return true;
    }

    return false;
}

// Function to connect to MQTT
WiFiClientSecure espClient;
PubSubClient mqttClient(espClient);

void connectToMqtt() {
    Serial.println("Connecting to MQTT broker...");

    espClient.setInsecure();
    mqttClient.setServer(mqtt_broker.c_str(), mqtt_port);

    while (!mqttClient.connected()) {
        Serial.println("Attempting MQTT connection...");
        if (mqttClient.connect(mqtt_username.c_str(), mqtt_username.c_str(), mqtt_password.c_str())) {
            Serial.println("Connected to MQTT broker.");
            mqttClient.subscribe(sub_topic.c_str());
        } else {
            Serial.print("Failed, retrying in 5 seconds...");
            delay(5000);
        }
    }
}

void setup() {
    Serial.begin(115200);
    WiFi.begin(ssid, password);

    Serial.print("Connecting to WiFi...");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi connected!");

  // Step 1: Validate Device
    if (!validateDevice()) {
    // Step 2: Register Device
        if (!registerDevice()) {
            Serial.println("Failed to register device.");
            return;
        }

        // Step 3: Get JWT Token
        if (!validateDevice()) {
            Serial.println("Failed to get JWT token.");
            return;
        }
    }

  // Step 4: Get MQTT Info
    if (!getMqttInfo()) {
        Serial.println("Failed to get MQTT info.");
        return;
    }

  // Step 5: Connect to MQTT
    connectToMqtt();
}

void loop() {
    mqttClient.loop();
}
