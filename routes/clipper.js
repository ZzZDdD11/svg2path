/**
 * SVG布尔运算
 */
const express = require(`express`);
const router = express.Router();

const axios = require('axios');
const { whitenSVG } = require('../src/clipper/whitenSVG');
//要求： 1.把get改成post 2.只接受xml 3.学会怎么调这个api

// svg转白色（POST 方式，xml 和 layer 放在 body 中；依然兼容旧的 query 参数）
router.post('/whiten', async (req, res, next) => {
  try {
    // 兼容：优先从 body 取参数，若无则回退到 query
    let { xml, layer, fillColor } = req.body;
    if (!xml) {
      ({ xml, layer, fillColor } = req.query);
    }
    let svg;
    // console.time('[clipper white] load svg');
    if (xml) {
      svg = xml;
    } else {
      throw new Error('require logo id, url or oss_object');
    }
    // console.timeEnd('[clipper white] load svg');

    // 默认白色
    fillColor = fillColor || '#ffffff';
    // console.time('[clipper white] caculate');
    const whiteSvgXml = await whitenSVG(svg, layer, fillColor);
    // console.timeEnd('[clipper white] caculate');

    res.json({
      status: 0,
      msg: 'ok',
      data: whiteSvgXml,
    });
  } catch (e) {
    res.json({
      status: 1,
      msg: e.message,
    });
  }

  next();
});

module.exports = router;
