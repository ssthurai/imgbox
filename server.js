// BASE SETUP
// =============================================================================

var express = require('express');
var app = express(); 
var http = require('http').Server(app);
var io = require('socket.io')(http);
var bodyParser = require('body-parser');
var auth = require('http-auth');
var request = require('request');

var basic = auth.basic({
    realm: 'SUPER SECRET STUFF'
}, function(username, password, callback) {
    callback(username == 'APIKEY'); // Insert your own authentication methods
});

var basicfront = auth.basic({
    realm: 'SUPER SECRET STUFF FRONT END'
}, function(username, password, callback) {
    callback(username == 'Admin' && password == 'scaleapi'); // Insert your own authentication methods
});

var authMiddleware = auth.connect(basic);
var authMiddlewarefront = auth.connect(basicfront);

var mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/imgbox');

var Task = require('./app/models/task');

// Before any of the relevant routes...

// configure app to use bodyParser()
// this will let us get the data from a POST
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(bodyParser.json());

var port = process.env.PORT || 8080; // set our port

// Front End Page

app.get('/', authMiddlewarefront, function(req, res) {
    res.sendfile('index.html');
});

// ROUTES FOR OUR API
// =============================================================================
var router = express.Router(); // get an instance of the express Router

// Main entry point for image annotations
router.post('/annotation', authMiddleware, function(req, res) {
    // create database entry of the task
    var task = new Task();
    task.instruction = req.body.instruction;
    task.attachment = req.body.attachment;
    if (!req.body.attachment) {
        res.send("Must specify a URL to an image");
    }
    task.attachment_type = req.body.attachment_type;
    if (req.body.objects_to_annotate.length == 0) {
        res.send("Must specify objects to annotate");
    }
    task.objects_to_annotate = req.body.objects_to_annotate;
    task.with_labels = false;
    if (req.body.with_labels) {
        task.with_labels = req.body.with_labels;
    }
    task.urgency = "day";
    if (req.body.urgency) {
        if (req.body.urgency == "immediete" ||
            req.body.urgency == "week" ||
            req.body.urgency == "day") {
            task.urgency = req.body.urgency;
        } else {
            res.send("Urgency must be immediete, week, or day");
        }
    }
    task.callback_url = req.body.callback_url;
    if (!req.body.callback_url) {
        res.send("Must specify a URL to callback");
    }
    task.created_at = new Date();
    task.api_key = req.user;
    task.status = "pending";
    task.type = "annotation";

    task.save(function(err) {
        if (err)
            res.send(err);

        // Send the json Response back to requester
        var jsonResponse = {};
        jsonResponse.task_id = task.id;
        jsonResponse.callback_url = task.callback_url;
        jsonResponse.type = "annotation";
        jsonResponse.status = "pending";
        jsonResponse.instruction = task.instruction;
        jsonResponse.urgency = task.urgency;
        var params = {};
        params.attachment = task.attachment;
        params.attachment_type = task.attachment_type;
        params.objects_to_annotate = task.objects_to_annotate;
        params.with_labels = task.with_labels;
        jsonResponse.params = params;

        res.json(jsonResponse);
    });
});

// WEB SOCKET COMMUNICATION
// =============================================================================

io.on('connection', function(socket) {
    console.log("someone connected");
    Task.find({
        status: "pending"
    }, function(err, tasks) {
        if (err) {
            io.emit("message", err);
        } else {
            io.emit("task", tasks[0]);
            io.emit("tasks", tasks);
        }
    });

    // When completed a task, will try to save to Database
    // and send POST request back to callback_url
    socket.on('task', function(data) {

        // Modify task in mongodb
        Task.findOne({
            _id: data._id
        }, function(err, task) {
            if (err) {
                io.emit("message", err);
            } else {
                io.emit("message", "Task found, starting to save to database...");
                task.completed_at = new Date();
                task.response = {
                    annotations: data.annotations
                };
                task.status = "completed";
                task.save(function(err) {
                    if (err) {
                        io.emit("message", err);
                    } else {

                        // Send request to callback url
                        io.emit("message", "Saved to database successfully, now sending request...");
                        var jsonResponse = {};
                        var mytask = JSON.parse(JSON.stringify(task));
                        var response = {};
                        var mytaskid = task._id
                        response = task.response;
                        delete mytask.api_key;
                        mytask.task_id = task._id;
                        delete mytask._id;
                        jsonResponse.task = mytask;
                        jsonResponse.response = response;
                        jsonResponse.task_id = mytaskid;
                        var options = {
                            uri: task.callback_url,
                            method: 'POST',
                            json: jsonResponse
                        };
                        request(options, function(err, response, body) {
                            if (err) {
                                io.emit("message", "Error sending request");
                            } else {
                                Task.find({
                                    status: "pending"
                                }, function(err, tasks) {
                                    if (err) {
                                        io.emit("message", err);
                                    } else {
                                        io.emit("tasks", tasks);
                                    }
                                });
                                io.emit("message", "Successfully sent request.");
                            }
                        });
                    }
                });
            }
        });
    });

    // When the front end sends an error about the task, send it back to callback_url
    socket.on('error_msg', function(data) {
        console.log(data);
        var options = {
            uri: data.task.callback_url,
            method: 'POST',
            json: {
                'error': data.error
            }
        };
        request(options, function(err, response, body) {
            if (err) {
                io.emit("message", "Error sending request");
            } else {
                io.emit("message", "Error successfully sent.");
            }
        });
    });

    // Sort by Urgency
    socket.on('most_important', function() {
        Task.find({
            urgency: "immediete"
        }, function(err, tasks) {
            if (err) {
                io.emit("message", err);
            } else {
                Task.find({
                    urgency: "day"
                }, function(err, tasks2) {
                    if (err) {
                        io.emit("message", err);
                    } else {
                        Task.find({
                            urgency: "week"
                        }, function(err, tasks3) {
                            io.emit("tasks", tasks.concat(tasks2.concat(tasks3)))
                        });
                    }
                });
            }
        });
    });

    // Sort by Date Created
    socket.on('date_created', function() {
        Task.find().sort('created_at').exec(function(err, tasks) {
            io.emit("tasks", tasks);
        });
    });

    // Dubug purposes, should not be used
    socket.on('reset', function() {
        Task.update({
                status: 'completed'
            }, {
                status: 'pending'
            }, {
                multi: true
            },
            function(err, num) {
                console.log("updated " + num);
            }
        );
    });
});


// REGISTER OUR ROUTES -------------------------------
app.use('/api/task', router);

app.use(express.static('public'));

// START THE SERVER
// =============================================================================
http.listen(port);
console.log('Magic happens on port ' + port);
