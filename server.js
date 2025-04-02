const express = require('express');
const https = require('https');
const http = require('http');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const env_config = require('./config'); // Import the config module
const db = require('./db'); // Import the database module
const { exec } = require('child_process'); // For executing shell commands
const fs = require('fs');

// Define Mosquitto configuration paths
const MQTT_PASSWD_FILE = "/etc/mosquitto/pwfile";
const MQTT_ACL_FILE = "/etc/mosquitto/aclfile.acl";
const MQTT_BROKER_IP = "172.28.182.164";
const MQTT_PORT = 1883;

// Certificate
// const options = {
//     key: fs.readFileSync('/home/pi/IOT_Server/server.key'),
//     cert: fs.readFileSync('/home/pi/IOT_Server/server.crt')
// };

// Initialize Express app
const app = express();
app.use(bodyParser.json());

// Determine the environment (production or test)
const isProduction = process.env.NODE_ENV === 'production';
const isTesting = process.env.NODE_ENV === 'test';

// Configure the server based on the environment
let server;
if (isProduction) {
    const options = {
        key: fs.readFileSync('/home/pi/IOT_Server/server.key'),
        cert: fs.readFileSync('/home/pi/IOT_Server/server.crt')
    };
    server = https.createServer(options, app);
} else {
    server = http.createServer(app); // Use plain HTTP for testing
}

// Create table for devices if not exists
db.run(`
    CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac_address TEXT UNIQUE,
        username TEXT,
        password TEXT
    )
`);

// **Function to Add a Device to Mosquitto**
function addMqttUser(username, password, callback) {
    if (isTesting) return callback(null);  // Skip this function in testing

    const passwdEntry = `${username}:${password}\n`;  // Format: username:password

    // Read the current mosquitto passwd file content
    fs.readFile(MQTT_PASSWD_FILE, 'utf8', (err, data) => {
        if (err && err.code !== 'ENOENT') {
            console.error(`Error reading password file: ${err}`);
            return callback(err);
        }

        // Append the new username and password to the file content
        const updatedPasswdContent = data ? data + passwdEntry : passwdEntry;

        // Write the updated content back to the password file
        fs.writeFile(MQTT_PASSWD_FILE, updatedPasswdContent, (err) => {
            if (err) {
                console.error(`Error writing password file: ${err}`);
                return callback(err);
            }
            console.log(`Added MQTT user: ${username}`);
            callback(null);
        });
    });
}


// **Function to Add ACL for a Device**
function addMqttAcl(username, callback) {
    if (isTesting) return callback(null);  // Skip this function in testing

    const aclEntry = `
    user ${username}
    topic read controllers/${username}/#
    topic write sensors/${username}/#
    `;

    // Read the current ACL file content
    fs.readFile(MQTT_ACL_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading ACL file: ${err}`);
            return callback(err);
        }

        // Check if the file already has content; if so, add a newline before appending the new ACL entry
        const updatedAclContent = data.trim() + '\n' + aclEntry;

        // Write the updated content back to the ACL file
        fs.writeFile(MQTT_ACL_FILE, updatedAclContent, (err) => {
            if (err) {
                console.error(`Error writing ACL file: ${err}`);
                return callback(err);
            } else {
                console.log(`ACL added for ${username}`);
            }
        });
    });
}



// **Function to Reload Mosquitto Without Restart**
function reloadMosquitto() {
    if (isTesting) return;  // Skip this function in testing
    
    exec(`sudo systemctl reload mosquitto`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error reloading Mosquitto: ${stderr}`);
        } else {
            console.log(`Mosquitto reloaded successfully.`);
        }
    });
}

// Validate API
app.post('/api/validate', (req, res) => {
    const { mac_address } = req.body;

    if (!mac_address) {
        return res.status(400).json({ message: 'MAC address is required.' });
    }

    // Check if the device is registered
    db.get('SELECT username, password FROM devices WHERE mac_address = ?', [mac_address], (err, row) => {
        if (err) return res.status(500).json({ message: 'Database error.' });

        if (row) {
            // Device is registered, generate a token
            const token = jwt.sign({ mac_address }, env_config.JWT_SECRET_KEY, { expiresIn: '1h' });
            return res.status(200).json({ message: 'Device validated.', token });
        } else {
            // Device not registered
            return res.status(404).json({ message: 'Device not registered.' });
        }
    });
});

// Register API
app.post('/api/register', (req, res) => {
    const { mac_address } = req.body;

    if (!mac_address) {
        return res.status(400).json({ message: 'MAC address is required.' });
    }

    // Generate username and password
    const username = `user_${mac_address.replace(/:/g, '')}`;  // Removes all colons from the MAC addres
    const password = Math.random().toString(36).slice(-8); // Random password

    // Insert into the database
    db.run(
        `INSERT INTO devices (mac_address, username, password) VALUES (?, ?, ?)`,
        [mac_address, username, password],
        function (err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(409).json({ message: 'Device already registered.' });
                }
                return res.status(499).json({ message: 'Database error.' });
            }

            // Add to Mosquitto authentication and ACL
            addMqttUser(username, password, (mqttErr) => {
                if (mqttErr) {
                    return res.status(501).json({ message: 'Failed to add MQTT user.' });
                }

                addMqttAcl(username, (aclErr) => {
                    if (aclErr) {
                        return res.status(502).json({ message: 'Failed to add MQTT ACL.' });
                    }

                    // Reload Mosquitto
                    reloadMosquitto();

                    res.status(201).json({
                        message: 'Device registered successfully.',
                        mqtt_username: username,
                        mqtt_password: password,
                    });
                });
            });
        }
    );
});


// Middleware to verify JWT token
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization']; 
	const token = authHeader && authHeader.split(' ')[1]; // Safer alternative
    
    if (!token) {
        return res.status(403).json({ message: 'Token is required.' });
    }

    jwt.verify(token, env_config.JWT_SECRET_KEY, (err, decoded) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token.' });
        }

        req.device = decoded;  // Attach decoded data (mac_address) to the request object
        next();
    });
}

// API to get MQTT broker info
app.get('/api/get-mqtt-info', verifyToken, (req, res) => {
    const { username } = req.query;  // Get the username from the request query

    if (!username) {
        return res.status(400).json({ message: 'Username is required.' });
    }

    // Validate if the username exists in the database
    db.get('SELECT * FROM devices WHERE username = ?', [username], (err, row) => {
        if (err) {
            return res.status(500).json({ message: 'Database error.' });
        }

        if (!row) {
            return res.status(404).json({ message: 'Device not registered.' });
        }

        // Generate the MQTT topics based on the username
        const mqttInfo = {
            broker_ip: MQTT_BROKER_IP,
            port: MQTT_PORT,
            username: username,  // Return the same username
            topics: [
                `sensors/${username}/#`,
                `controllers/${username}/#`
            ]
        };

        return res.status(200).json({
            message: 'MQTT information retrieved successfully.',
            mqttInfo
        });
    });
});


// Start HTTPS server
// const SERVER_IP = '0.0.0.0'; 
// const PORT = 3000; // Standard HTTPS port
// // https.createServer(options, app).listen(PORT, SERVER_IP, () => {
// //     console.log(`HTTPS Server running at https://${SERVER_IP}:${PORT}`);
// //     reloadMosquitto();
// // });
// server.listen(PORT, SERVER_IP, () => {
//     console.log(`Server running at ${isProduction ? 'https' : 'http'}://${SERVER_IP}:${PORT}`);
//     reloadMosquitto();
// });

// Start the server only if this file is run directly
const SERVER_IP = '0.0.0.0';
const PORT = 3000;
if (require.main === module) {
    server.listen(PORT, SERVER_IP, () => {
        console.log(`Server running at ${isProduction ? 'https' : 'http'}://${SERVER_IP}:${PORT}`);
        reloadMosquitto();
    });
}

// Export the app and functions for testing
module.exports = {
    app,
    addMqttUser,
    addMqttAcl,
    reloadMosquitto
};