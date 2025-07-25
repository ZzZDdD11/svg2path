/**
 * NodeJS 服务端API
 */
var express = require('express');
var bodyParser = require('body-parser'); //http request请求体解析
var cors = require('cors'); //支持跨域请求
var clipper = require('./routes/clipper');

var app = express();
//支持跨域
app.use(cors());
// 解析 application/json
app.use(bodyParser.json({ extended: true, limit: '50mb' }));
// 解析 application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// 挂载路由
app.use(`/clipper`, clipper);

app.listen(8888, function () {
  console.log('Logomaker Clipper API Server listening on port 8888');
});
