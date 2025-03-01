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
#include <Preferences.h>

// Replace with your WiFi credentials
const char* ssid = "RD-SEAI_2.4G";
const char* password = "";

// Replace with your IoT server's IP and port
const char* server_url = "https://172.28.182.164:3000";

const char* root_ca = 
    "-----BEGIN CERTIFICATE-----\n"
    "MIIDFDCCAfygAwIBAgIUDM5zmTSP+ewEnuXfq/xVNu2HSpswDQYJKoZIhvcNAQEL\n"
    "BQAwETEPMA0GA1UEAwwGc2VydmVyMB4XDTI1MDMwMTA2MzIzNFoXDTI2MDMwMTA2\n"
    "MzIzNFowETEPMA0GA1UEAwwGc2VydmVyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n"
    "MIIBCgKCAQEAyHJODY8bgnhLyDeKGONpLNN+YXPR9aMnpoRXWBCEyfGBj5d8STls\n"
    "UHJigjxDSTPzNqzZT0q3vww5v1693JUPSeu0AwPEl6wyY1ciZwpTAw/6lO+tmDNU\n"
    "024+luU43TE+PGYM1VUuMqeRreIAtwoqRQ+7f7VVYjnCBDWliIjTNfIXqbQfUNll\n"
    "9usnsGk5aFXG2vHwI+5z+nMyuOUDNLXyNYYqdncunxmEc5RxOB4MXGE0CxeUo4Ec\n"
    "IwR8RqNpB/ZGwP96XcQZ/Ken5n01fOYivwxIJjcXrpSfbjWZayg5+4mJwwNYMfDa\n"
    "UQEa54R5yI2lplGDIWvIJPK1XCrBTuKSrQIDAQABo2QwYjAdBgNVHQ4EFgQUs02M\n"
    "rPjmN4X1jvuaH20xOseW7TEwHwYDVR0jBBgwFoAUs02MrPjmN4X1jvuaH20xOseW\n"
    "7TEwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwSsHLakMA0GCSqGSIb3DQEB\n"
    "CwUAA4IBAQA06JSZ3HcUB6gv5sGo5AAdIHvMCTpuYK5kupmGL/XFiGJa1xDzZeWu\n"
    "NivfwJO9GfZsePYIA3KKhoQh98iIi3uQs6nsW4xwFYhsoeq7K9vKhSISH6VLpKMb\n"
    "/YJRLpzwIefvmSoOsdrQ+gv6M+TjfExIsXNCM8/mxjBlqlSxhqSjfSAmGH91Cwcy\n"
    "Fa3oaz9GiTCU3lIC7tEBx/poqtrV5FZw9Pay8SM1iS+SUaX+kv9RI8WUuuO67QIB\n"
    "EOsdLUrTIeWgz2YfMTzYDA6BWyGNy09qAQzPSWZ4+7m2FAElhIN8h4hxQ2uUqQPu\n"
    "/7IYTuI3ixCOZl0vs+oT5zqzoNqpA8zU\n"
    "-----END CERTIFICATE-----\n";

// MQTT Credentials (To be received from the server)
String mqtt_broker;
int mqtt_port;
String mqtt_username;
String mqtt_password;
String pub_topic;
String sub_topic;
Preferences preferences;

// Token for authentication
String jwt_token;

// Global clients
WiFiClientSecure secureClient;  // For HTTPS
WiFiClient espClient;           // For MQTT (non-TLS)
PubSubClient mqttClient(espClient);

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

    String fullUrl = String(server_url) + endpoint;
    http.begin(secureClient, fullUrl);  // Use secureClient for HTTPS
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

        // Store mqtt_username in flash memory
        preferences.begin("device_data", false);  // Open the preferences namespace
        preferences.putString("mqtt_username", mqtt_username);  // Save the username
        preferences.putString("mqtt_password", mqtt_password);  // Save the password
        preferences.end();  // Close the preferences

        Serial.println("Device registered successfully.");
        return true;
    }   

    Serial.println("Device registration failed.");
    return false;
}

// Function to get MQTT info from the server
bool getMqttInfo() {
    Serial.println("Getting MQTT information...");

    // Construct the full URL for the GET request
    String fullUrl = String(server_url) + "/api/get-mqtt-info?username=" + mqtt_username;
    
    // Use WiFiClient for non-secure HTTP connection
    HTTPClient http;

    http.begin(secureClient, fullUrl);  // Use secureClient for HTTPS
    http.addHeader("Authorization", "Bearer " + jwt_token);  // Add JWT token for authorization

    http.setTimeout(5000);

    int httpResponseCode = http.GET();  // Send GET request
    String response = "";

    if (httpResponseCode > 0) {
        response = http.getString();  // Get the response body as a string
    } else {
        // Print error if request fails
        Serial.printf("Failed to get MQTT info. Error: %s\n", http.errorToString(httpResponseCode).c_str());
        return false;
    }

    http.end();  // Close HTTP connection

    // Parse the JSON response
    DynamicJsonDocument doc(512);
    deserializeJson(doc, response);

    // Check if the server responded with success
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


void getMqttUsernameFromFlash() {
    // Initialize Preferences library
    preferences.begin("device_data", true);  // Open the preferences in read-only mode

    // Check if the username is stored
    String storedUsername = preferences.getString("mqtt_username", "");  // Default to empty string if not found
    String storedPassword = preferences.getString("mqtt_password", "");  // Default to empty string if not found
    
    if (storedUsername != "") {
        Serial.println("Stored MQTT Username: " + storedUsername);
        mqtt_username = storedUsername;  // Set the mqtt_username to the stored value
        mqtt_password = storedPassword;  // Set the mqtt_password to the stored value
    } else {
        Serial.println("No stored MQTT Username found from flash mem.");
    }

    preferences.end();  // Close the preferences
}

void connectToMqtt() {
    Serial.println("Connecting to MQTT broker...");

  // espClient.setInsecure();
  // mqttClient.setServer(mqtt_broker.c_str(), mqtt_port);

  // while (!mqttClient.connected()) {
  //   Serial.println("Attempting MQTT connection...");
  //   if (mqttClient.connect(mqtt_username.c_str(), mqtt_username.c_str(), mqtt_password.c_str())) {
  //     Serial.println("Connected to MQTT broker.");
  //     mqttClient.subscribe(sub_topic.c_str());
  //   } else {
  //     Serial.print("Failed, retrying in 5 seconds...");
  //     delay(5000);
  //   }
  // }
}

void setup() {
    Serial.begin(9600);
    WiFi.begin(ssid, password);

    Serial.print("Connecting to WiFi...");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi connected!");

    // Set the server's certificate for HTTPS
    secureClient.setCACert(root_ca);

    // Step 1: Validate Device
    if (!validateDevice()) {
    // Step 2: Register Device
        if (!registerDevice()) {
        Serial.println("Failed to register device.");
        return;
        }

        // Step 3: Get JWT Token
        delay(500);
        if (!validateDevice()) {
        Serial.println("Failed to get JWT token.");
        return;
        }
    }

    // Step 4: Get MQTT Info
    delay(500);
    getMqttUsernameFromFlash();
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
