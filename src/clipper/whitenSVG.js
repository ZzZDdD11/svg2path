// Turns SVG shapes (polygon, polyline, rect, g) into SVG paths. It can merge groups and apply transforms
const svgFlatten = require('svg-flatten');
// flatten-svg normalizes SVG shape data into a simplified line segment form suitable for, say, a plotter. All shapes are reduced to line segments, accurate to within a configurable error margin.
const { flattenSVG } = require('flatten-svg');
const ClipperLib = require('../lib/clipper_unminified');
const tinycolor = require('tinycolor2');

const { createSVGWindow } = require('svgdom');
const window = createSVGWindow();

let cpr;

/**
 * 去掉嵌套的svg元素，换成g元素
 */
function reduceSVG(svgXml) {
  // 删除可能存在的多余的xml定义，会导致后面svgXml转base64出错
  let _svgXml = svgXml.replace(/^[\s\S]*?(<svg)/i, '$1');
  // 删除背景
  _svgXml = _svgXml.replace(/<g[^>]*?id="background"[^>]*?>(((?<!<g)[\s\S])*?)<\/g>/im, '');
  // 删除svgXml的<switch>和</switch>标签，因为svgFlatten不能正确处理switch标签
  _svgXml = _svgXml.replace(/<[/]?switch[^>]*?>/gim, '');

  // 把svg内嵌套的svg标签替换为g标签
  const svgReg = /(?<=\S\s*)<svg[^>]*?>(((?<!<svg)[\s\S])*?)<\/svg>/im;
  let matchResult;
  const xmlnsReg = /xmlns(:[^=]+)?="[^"]+"/gim; // 提取svg的 xmlns:xxx 和 xmlns 属性
  let xmlnsAttrsAll = [];
  while ((matchResult = svgReg.exec(_svgXml)) !== null) {
    const { viewBox, width, height } = getSvgRect(matchResult[0]);
    const [vx, vy, vw, vh] = viewBox.split(' ');

    let scaleX = parseFloat(width) / vw;
    let scaleY = parseFloat(height) / vh;
    if (isNaN(scaleX)) {
      scaleX = 1;
    }
    if (isNaN(scaleY)) {
      scaleY = 1;
    }
    const dx = -vx * scaleX;
    const dy = -vy * scaleY;

    // 提取matchResult[0]里的 xmlns:xxx="xxx" 和 xmlns=“”属性
    const xmlnsAttrs = matchResult[0].match(xmlnsReg);
    xmlnsAttrsAll.push(...xmlnsAttrs);

    _svgXml = _svgXml.replace(svgReg, (match, content) => {
      return `<g transform="translate(${dx}, ${dy}) scale(${scaleX}, ${scaleY})">${content}</g>`;
    });
  }

  // 把_svgXml上的xmlns属性提取出来，把xmlnsAttrsAll里不包含在_svgXml上的xmlns属性加到_svgXml的<svg>标签内
  // xmlnsAttrsAll去重复
  xmlnsAttrsAll = Array.from(new Set(xmlnsAttrsAll));
  const xmlnsAttrsRoot = _svgXml.match(xmlnsReg);
  const xmlnsAttrsMore = xmlnsAttrsAll.filter(attr => !(xmlnsAttrsRoot && xmlnsAttrsRoot.includes(attr)));
  if (xmlnsAttrsMore.length) {
    _svgXml = _svgXml.replace(/<svg[^>]*>/, match => {
      return match.slice(0, -1) + ' ' + xmlnsAttrsMore.join(' ') + match.slice(-1);
    });
  }

  // 把应用了clip-path的元素转为g元素
  const clipPathReg = /clip-path/gim;
  if (clipPathReg.test(_svgXml)) {
    const div = window.document.createElement('div');
    div.innerHTML = _svgXml;
    const elems = div.querySelectorAll('[clip-path]');
    elems.forEach(elem => {
      const clipPath = elem.getAttribute('clip-path');
      const clipPathId = clipPath.replace('url(#', '').replace(')', '');
      const clipPathElem = div.querySelector(`#${clipPathId}`);
      if (clipPathElem) {
        // 用来替换elem的元素
        const replaceElems = [];
        clipPathElem.children.forEach(child => {
          if (child.tagName.toLowerCase() === 'use') {
            // 继续找元素
            const href = child.getAttribute('xlink:href') || child.getAttribute('href');
            const clipPathUse = href && div.querySelector(href);
            if (clipPathUse) {
              const cloneElem = clipPathUse.cloneNode(true);
              cloneElem.removeAttribute('id');
              cloneAttributes(elem, cloneElem, ['clip-path', 'width', 'height', 'x', 'y']);
              replaceElems.push(cloneElem);
            }
          } else {
            const cloneElem = child.cloneNode(true);
            cloneElem.removeAttribute('id');
            cloneAttributes(elem, cloneElem, ['clip-path', 'width', 'height', 'x', 'y']);
            replaceElems.push(cloneElem);
          }
        });
        // 用replaceElems替换elem
        replaceElems.forEach(replaceElem => {
          elem.parentNode.insertBefore(replaceElem, elem);
        });
        elem.remove();
      }
    });
    _svgXml = div.innerHTML;
  }

  // 删除不可见的元素
  // 因为布尔运算只计算曲线内部，所以不保留没有fill（即使有stroke）的元素
  // 这个操作必须在clip-path转换后，因为clip-path的元素可能不可见，但是应用了clip-path的元素可能是可见的
  _svgXml = _svgXml.replace(
    /<(?<SvgTag>[\w]+)[^>]*?(fill="rgba\([\d\s]+,[\d\s]+,[\d\s]+,\s*0\s*\)"|fill="none"|opacity="0")([^>]*?\/>|[^>]*?>(((?<!<[\w]+)[\s\S])*?)<\/\k<SvgTag>>)/gim,
    ''
  );

  // svgFlatten的pathify方法不能正确转换rect的rx和ry属性，
  // 自己实现的把rect转为path
  // 用正则判断是否有带rx或ry的rect
  const rectReg = /<rect[^>]*?(rx|ry)[^>]*?>/gim;
  if (rectReg.test(_svgXml)) {
    const div = window.document.createElement('div');
    div.innerHTML = _svgXml;
    const rects = div.querySelectorAll('rect');
    rects.forEach(rect => {
      const x = parseFloat(rect.getAttribute('x') || 0);
      const y = parseFloat(rect.getAttribute('y') || 0);
      const width = parseFloat(rect.getAttribute('width') || 0);
      const height = parseFloat(rect.getAttribute('height') || 0);
      const rx = parseFloat(rect.getAttribute('rx') || 0);
      const ry = parseFloat(rect.getAttribute('ry') || 0);
      const path = window.document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', rect.getAttribute('fill') || '');
      path.setAttribute('transform', rect.getAttribute('transform') || '');
      path.setAttribute('class', rect.getAttribute('class') || '');
      path.setAttribute(
        'd',
        `M${x + rx},${y}h${width - rx * 2}${rx ? `a${rx},${ry} 0 0 1 ${rx},${ry}` : ''}v${height - ry * 2}${
          rx ? `a${rx},${ry} 0 0 1 -${rx},${ry}` : ''
        }h-${width - rx * 2}${rx ? `a${rx},${ry} 0 0 1 -${rx},-${ry}` : ''}v-${height - ry * 2}${
          rx ? `a${rx},${ry} 0 0 1 ${rx},-${ry}` : ''
        }Z`
      );
      rect.parentNode.replaceChild(path, rect);
    });
    _svgXml = div.innerHTML;
  }

  return _svgXml;
}

function cloneAttributes(from, to, exclude = []) {
  // 把elem的属性全部转移到g上，除了clip-path，width和height,x和y
  Array.from(from.attributes).forEach(attr => {
    if (!exclude.includes(attr.name)) {
      to.setAttribute(attr.name, attr.value);
    }
  });
}

/**
 * 把svgXml转化成适合布尔运算的数据结构
 */
function svg2paths(svgXml) {
  const pathSvg = svgFlatten(svgXml).pathify();

  // 把fill值相同的连续path合并分组
  const groups = groupByFill(pathSvg);

  window.document.documentElement.innerHTML = pathSvg.flatten().value();
  const svgData = flattenSVG(window.document.documentElement);
  const paths = svgData.map(path =>
    path.points.map(point => {
      return !isNaN(point.x) && !isNaN(point.y) ? { X: point.x, Y: point.y } : {};
    })
  );

  // 去掉重复路径，比如文字加边框后会有2个一模一样的路径，会导致异或运算后文字不可见
  const pathsString = paths.map(path => paths2string([path]));
  pathsString.forEach((item, index) => {
    if (pathsString.indexOf(item) !== index) {
      paths[index] = [];
    }
  });

  const groupPaths = [];
  let index = 0;
  groups.forEach(group => {
    groupPaths.push(paths.slice(index, index + group.count));
    index += group.count;
  });

  return groupPaths;
}
/**
 * 把svg中fill值相同的连续path合并分组，返回分组信息
 */
function groupByFill(pathSvg) {
  const paths = getPaths(pathSvg._value);

  const groups = [];
  let prevFill = '',
    groupCount = 0;

  paths.forEach(path => {
    const {
      attr: { d = '', fill = '#000000' },
    } = path;
    const fillHex = tinycolor(fill).toHex8();

    if (prevFill && prevFill !== fillHex) {
      groups.push({
        fill: prevFill,
        count: groupCount,
      });
      groupCount = 0;
    }

    const pathStarts = d.match(/M/gim);
    groupCount += pathStarts ? pathStarts.length : 0;
    prevFill = fillHex;
  });

  groups.push({
    fill: prevFill,
    count: groupCount,
  });

  return groups;
}

/**
 * 从doc中递归得到全部的path
 */
function getPaths(elem) {
  if (elem.children.length) {
    return elem.children.reduce((paths, child) => [...paths, ...getPaths(child)], []);
  } else if (elem.name === 'path') {
    return [elem];
  } else {
    return [];
  }
}

/**
 * path分层，优化path数量大时的运算次数
 */
function slicePaths(paths, maxLayer = 32) {
  if (paths.length <= maxLayer) {
    return paths;
  }

  const layers = [];
  const size = Math.floor(paths.length / maxLayer);
  const remainder = paths.length % maxLayer;
  let index = 0;
  while (index < paths.length) {
    const layerSize = layers.length < remainder ? size + 1 : size;
    layers.push(paths.slice(index, index + layerSize).reduce((layer, path) => layer.concat(path)));
    index += layerSize;
  }
  return layers;
}

/**
 * 对分层的path进行递归xor运算
 */
function clipLayers(layers, clipperOptions) {
  const paths = layers.length ? layers.reduce((paths, layer) => clip(paths, layer, clipperOptions)) : [];
  return ClipperLib.JS.Clean(paths, 0.1);
}

/**
 * ClipperLib布尔运算
 */
function clip(subj_paths, clip_paths, options) {
  const {
    clipType = 3, // 剪切类型：交集0，并集1，差集2，异或3
    subject_fillType = 1, // 填充类型：奇偶0，非零1，正向2，负向3
    clip_fillType = 1,
    PreserveCollinear = false,
    ReverseSolution = false,
    StrictlySimple = false,
  } = options || {};

  if (!cpr) {
    cpr = new ClipperLib.Clipper();
    cpr.PreserveCollinear = Boolean(PreserveCollinear);
    cpr.ReverseSolution = Boolean(ReverseSolution);
    cpr.StrictlySimple = Boolean(StrictlySimple);
  } else {
    cpr.Clear();
  }

  cpr.AddPaths(subj_paths, ClipperLib.PolyType.ptSubject, true);
  cpr.AddPaths(clip_paths, ClipperLib.PolyType.ptClip, true);

  const solution_paths = new ClipperLib.Paths();
  cpr.Execute(clipType, solution_paths, subject_fillType, clip_fillType);

  return solution_paths;
}

/**
 * Converts polygons points to SVG path string
 */
function paths2string(paths) {
  let svgpath = '';
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths[i].length; j++) {
      svgpath += `${j ? 'L' : 'M'}${paths[i][j].X},${paths[i][j].Y}`;
    }
    svgpath += 'Z';
  }
  if (!svgpath) svgpath = 'M0,0';
  return svgpath;
}

/**
 * Get SVG viewBox, width, height
 */
function getSvgRect(svgXml) {
  const viewBoxReg = /<svg[\s\S]*?viewBox="([^"]+?)"/im;
  const widthReg = /<svg[\s\S]*?width="([^"]+?)"/im;
  const heightReg = /<svg[\s\S]*?height="([^"]+?)"/im;

  const viewBox = viewBoxReg.exec(svgXml);
  const width = widthReg.exec(svgXml);
  const height = heightReg.exec(svgXml);

  return {
    viewBox: viewBox ? viewBox[1] : '',
    width: width ? width[1] : '',
    height: height ? height[1] : '',
  };
}

/**
 * 把布尔运算结果转化成白色svgXml
 */
function getWhiteSvg(paths, svgXml, fillColor = '#ffffff') {
  const { viewBox, width, height } = getSvgRect(svgXml);
  // 分析viewBox和实际尺寸的关系
  let finalViewBox = viewBox;
  let vx = 0, vy = 0, vw = 0, vh = 0;
  let scaleX = 1, scaleY = 1;
  
  if (viewBox && viewBox.trim()) {
    const viewBoxParts = viewBox.split(' ');
    if (viewBoxParts.length >= 4) {
      vx = parseFloat(viewBoxParts[0]) || 0;
      vy = parseFloat(viewBoxParts[1]) || 0;
      vw = parseFloat(viewBoxParts[2]) || 300;
      vh = parseFloat(viewBoxParts[3]) || 300;
    }
  } else {
    // 如果没有viewBox，根据width和height创建
    const w = parseFloat(width) || 300;
    const h = parseFloat(height) || 300;
    finalViewBox = `0 0 ${w} ${h}`;
    vx = 0;
    vy = 0;
    vw = w;
    vh = h;
  }
  
  // 计算实际尺寸和viewBox尺寸的缩放比例
  if (width && height && vw && vh) {
    const actualWidth = parseFloat(width);
    const actualHeight = parseFloat(height);
    if (!isNaN(actualWidth) && !isNaN(actualHeight)) {
      scaleX = actualWidth / vw;
      scaleY = actualHeight / vh;
    }
  }
  
  // 确保width和height有值
  const finalWidth = width || '300';
  const finalHeight = height || '300';
  
  // 如果有缩放，需要调整viewBox以匹配实际的路径坐标
  if (scaleX !== 1 || scaleY !== 1) {
    // 路径坐标基于实际尺寸，所以viewBox也应该基于实际尺寸
    const scaledVx = vx * scaleX;
    const scaledVy = vy * scaleY;
    const scaledVw = vw * scaleX;
    const scaledVh = vh * scaleY;
    finalViewBox = `${scaledVx} ${scaledVy} ${scaledVw} ${scaledVh}`;
    
    // transform也需要相应调整
    vx = scaledVx;
    vy = scaledVy;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" preserveAspectRatio="none" 
    viewBox="${finalViewBox}" width="${finalWidth}" height="${finalHeight}">
      <path transform="translate(${vx}, ${vy})" fill="${fillColor}" fill-rule="evenodd" d="${paths2string(paths)}" /></svg>`;
}

function maskToElement(svgXml, maxLayer) {
  const div = window.document.createElement('div');
  div.innerHTML = svgXml;
  const svgDom = div.querySelector('svg');
  const masks = svgDom.querySelectorAll('mask');
  if (!masks) {
    return svgXml;
  }

  const svgRect = getSvgRect(svgXml);

  masks.forEach(mask => {
    const maskId = mask.getAttribute('id');
    const useMasks = svgDom.querySelectorAll('[mask]').filter(elem => elem.getAttribute('mask') === `url(#${maskId})`);

    if (!useMasks.length) {
      return;
    }
    const useMaskSvg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    useMasks.forEach(useMask => {
      useMaskSvg.appendChild(useMask);
    });
    const useMasKPaths = svgToClipperPaths(useMaskSvg.outerHTML, maxLayer);

    // 把maskSvg里的fill="#ffffff"求合集，fill="#000000"的路径也求合集，然后用fill="#ffffff"的路径减去fill="#000000"的路径
    const maskSvg = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    // 删除mask里的fill="#000000"的路径
    maskSvg.innerHTML = mask.innerHTML;
    maskSvg
      .querySelectorAll('[fill]')
      .filter(elem => elem.getAttribute('fill') === '#000000')
      .forEach(elem => {
        elem.remove();
      });
    // xxx: 为什么要把width="100%"的元素的width改为svgRect.width？否则clipper运算结果不正确
    maskSvg
      .querySelectorAll('[width]')
      .filter(elem => elem.getAttribute('width') === '100%')
      .forEach(elem => {
        elem.setAttribute('width', svgRect.width);
        if (elem.getAttribute('height') === '100%') {
          elem.setAttribute('height', svgRect.height);
        }
      });
    const maskSvgWhite = maskSvg.outerHTML;
    const maskPathsWhite = svgToClipperPaths(maskSvgWhite, maxLayer, { clipType: 1 }); // 并集

    // 获得mask里的fill="#ffffff"或fill="#FFFFFF"的路径
    maskSvg.innerHTML = mask.innerHTML;
    maskSvg
      .querySelectorAll('[fill]')
      .filter(elem => elem.getAttribute('fill').toLowerCase() === '#ffffff')
      .forEach(elem => {
        elem.remove();
      });
    const maskSvgBlack = maskSvg.outerHTML;
    const maskPathsBlack = svgToClipperPaths(maskSvgBlack, maxLayer, { clipType: 1 }); // 并集

    const maskPaths = clipLayers([maskPathsWhite, maskPathsBlack], { clipType: 2 }); // 差集
    const maskResultPaths = clipLayers([useMasKPaths, maskPaths], { clipType: 0 }); // 交集
    const gElem = window.document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gElem.innerHTML = `<path fill="#000000" d="${paths2string(maskResultPaths)}" />`;

    mask.parentNode.replaceChild(gElem, mask);
  });
  return div.innerHTML;
}

function svgToClipperPaths(svgXml, maxLayer, clipperOptions) {
  // 去掉嵌套的svg元素，换成g元素
  const plainSvg = reduceSVG(svgXml);
  // 把svgXml转化成适合布尔运算的数据结构
  const paths = svg2paths(plainSvg);
  // path分层，优化path数量大时的运算次数
  const layers = slicePaths(paths, maxLayer);
  // 核心：分层布尔运算，默认算法异或运算
  const clipperPaths = clipLayers(layers, clipperOptions);

  return clipperPaths;
}

// 修改whitenSVG支持传递fillColor
function whitenSVG(svgXml, maxLayer, fillColor = '#ffffff') {
  // 先计算mask的异或结果
  svgXml = maskToElement(svgXml, maxLayer);
  // 核心：图层异或运算
  const xorPaths = svgToClipperPaths(svgXml, maxLayer);
  // 把布尔运算结果转化成svgXml
  const whiteSvg = getWhiteSvg(xorPaths, svgXml, fillColor);

  return whiteSvg;
}

module.exports = {
  reduceSVG,
  whitenSVG,
};
