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
        password TEXT,
        refresh_token TEXT
    )
`);

// **Function to Add a Device to Mosquitto**
function addMqttUser(username, password, callback) {
    if (isTesting) return callback(null);  // Skip this function in testing

    const tempFile = `/tmp/temp_pwfile_${Date.now()}`; // Unique temporary file
    const plainEntry = `${username}:${password}\n`;

    // Step 1: Write plain-text entry to temporary file
    fs.writeFile(tempFile, plainEntry, (err) => {
        if (err) {
            console.error(`Error writing temporary file: ${err}`);
            return callback(err);
        }

        // Step 2: Hash the temporary file using mosquitto_passwd -U
        exec(`sudo mosquitto_passwd -U ${tempFile}`, (err, stdout, stderr) => {
            if (err) {
                console.error(`Error hashing password: ${stderr}`);
                fs.unlink(tempFile, () => {}); // Clean up on error
                return callback(err);
            }

            // Step 3: Read the hashed entry
            fs.readFile(tempFile, 'utf8', (err, hashedEntry) => {
                if (err) {
                    console.error(`Error reading hashed entry: ${err}`);
                    fs.unlink(tempFile, () => {}); // Clean up on error
                    return callback(err);
                }

                // Step 4: Append to the main pwfile
                fs.appendFile(MQTT_PASSWD_FILE, hashedEntry, { flag: 'a' }, (err) => {
                    if (err) {
                        console.error(`Error appending to pwfile: ${err}`);
                        fs.unlink(tempFile, () => {}); // Clean up on error
                        return callback(err);
                    }

                    console.log(`Added MQTT user: ${username}`);

                    // Step 5: Delete the temporary file
                    fs.unlink(tempFile, (err) => {
                        if (err) console.error(`Error deleting temporary file: ${err}`);
                        callback(null);
                    });
                });
            });
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
    exec(`echo "${aclEntry}" | sudo /usr/local/bin/append_to_acl.sh`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error updating ACL file: ${error}`);
            return callback(error);
        }
        console.log(`ACL added for ${username}`);
        callback(null);
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
    if (!mac_address) return res.status(400).json({ message: 'MAC address is required.' });
    db.get('SELECT username, password FROM devices WHERE mac_address = ?', [mac_address], (err, row) => {
        if (err) return res.status(500).json({ message: 'Database error.' });
        if (row) {
            const accessToken = jwt.sign({ mac_address }, env_config.JWT_SECRET_KEY, { expiresIn: '1h' });
            const refreshToken = jwt.sign({ mac_address }, env_config.REFRESH_TOKEN_SECRET, { expiresIn: '7d' });
            db.run('UPDATE devices SET refresh_token = ? WHERE mac_address = ?', [refreshToken, mac_address], (err) => {
                if (err) return res.status(500).json({ message: 'Database error.' });
                return res.status(200).json({ message: 'Device validated.', accessToken, refreshToken });
            });
        } else {
            return res.status(404).json({ message: 'Device not registered.' });
        }
    });
});

// Refresh Token API
app.post('/api/refresh-token', (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ message: 'Refresh token is required.' });
    jwt.verify(refreshToken, env_config.REFRESH_TOKEN_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ message: 'Invalid or expired refresh token.' });
        const mac_address = decoded.mac_address;
        db.get('SELECT refresh_token FROM devices WHERE mac_address = ?', [mac_address], (err, row) => {
            if (err || !row || row.refresh_token !== refreshToken) {
                return res.status(403).json({ message: 'Invalid refresh token.' });
            }
            const newAccessToken = jwt.sign({ mac_address }, env_config.JWT_SECRET_KEY, { expiresIn: '1h' });
            return res.status(200).json({ message: 'Access token refreshed.', accessToken: newAccessToken });
        });
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
	const token = authHeader && authHeader.split(' ')[1]; 

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
module.exports = { app, addMqttUser, addMqttAcl, reloadMosquitto };