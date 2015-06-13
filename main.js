/**
 * Created by yoon on 3/25/15.
 */

/** @namespace Pla */
(function(Pla){
    "use strict";

    Pla.Param = {
        PAGE_W: 500.0,
        NARROW_COLUMN_W: 150,
        MIN_ALLEY_W: 9,
        EPSILON_IMAGE_FILTER_BG: 4.0,
        PAGENUM_DETECTION_RANGE_Y: 80,
        TWOCOLUMN_MIN_H: 50,
        EDGE_SPLATTER_HIST_L_WINDOW: 9, // === MIN_ALLEY_W
        EDGE_SPLATTER_HIST_R_WINDOW: 9*3.0,  // === MIN_ALLEY_W*3.0
        EDGE_SPLATTER_HIST_R_LPF_W: 10,
        EDGE_SPLATTER_HIST_L_CUTOFF_RATIO: 4.0,
        EDGE_SPLATTER_HIST_R_CUTOFF_RATIO: 1.5,
        MULTICOLUMN_MERGE_Y: 3
    };

    Pla.model = (function(){
        var pub = {};

        var pdf;
        var num_pages = 0;
        var page_data = [];
        var page_datum = {};
        var _mupladoc = [];

        pub.getNumPages = function(){return num_pages;};

        pub.Init = function(pdf_path, pdf_filename, nfiles){
            return getMuPlaJs(pdf_path, pdf_filename, nfiles).then(
                getPdf
            );
        };

        function getMuPlaJs(pdf_path, pdf_filename, nfiles){
            return new Promise(function(resolve, reject){
                function job(n){
                    if(n != nfiles){
                        Pla.util.getUrlData(
                            pdf_path+n+".pdf.js",
                            ""
                            //ToDo replace it with Pla.ctx
                        ).then(
                            function(js){
                                _mupladoc = _mupladoc.concat(JSON.parse(js));
                                job(n+1);
                            }
                        ).catch(reject);
                    }
                    else{
                        for(var i = 0; i < _mupladoc.length; ++i){
                            _mupladoc[i].GetRects = function(){
                                var rects = [];
                                for(var i = 0; i < this.tblocks.length; ++i){
                                    var lines = this.tblocks[i].lines;
                                    for(var j = 0; j < lines.length; ++j){
                                        rects.push(lines[j].bbox);
                                    }
                                }
                                return rects;
                            };
                        }
                        resolve(pdf_path+pdf_filename);
                    }
                }
                job(0);
            });
        }

        function getPdf(path){
            return Pla.util.getUrlData(
                path,
                "arraybuffer",
                null
            ).then(
                PDFJS.getDocument
            ).then(
                function(_pdf){ // cb_success
                    pdf = _pdf;
                    num_pages = pdf.pdfInfo.numPages;
                    for(var i = 0; i < num_pages; ++i){
                        page_data.push(null);
                    }
                    console.log("Model.Init:", num_pages, "pages");
                }
            //).then(
            //    populatePdfPageData
            );
        }

        function populatePdfPageData(){
            return new Promise(function(resolve, reject){
                var job = function(n){
                    if(n != num_pages){
                        pub.getPdfPageData(n).then(function(){
                            job(n+1);
                        }).catch(reject);
                    }
                    else{
                        resolve();
                    }
                };
                job(0);
            });
        }

        /** called in the pdf.js */
        pub.addImgRect = function(rect){
            page_datum.img_boxes.push(rect);
        };

        pub.getPdfPageData = function(n){
            return new Promise(function(resolve, reject){
                if(page_data[n]){
                    resolve(page_data[n]);
                }
                else{
                    pdf.getPage(n+1).then(function(page){
                        var s = Pla.Param.PAGE_W / (page.pageInfo.view[2]); // set page width
                        var viewport = page.getViewport(s);
                        var canv = document.createElement('canvas');
                        var canv_ctx = canv.getContext('2d');
                        var canv_pixel_ratio = Pla.util.getOutputScale(canv_ctx);

                        canv.width = Math.floor(viewport.width*canv_pixel_ratio.sx) | 0;
                        canv.height = Math.floor(viewport.height*canv_pixel_ratio.sy) | 0;
                        canv_ctx.scale(canv_pixel_ratio.sx, canv_pixel_ratio.sy);

                        page_datum = {};
                        page_datum.img_boxes = [];
                        page_datum.canvas = canv;
                        page_datum.mupla = _mupladoc[n];
                        page.render({
                            canvasContext: canv_ctx,
                            viewport: viewport
                        }).then(function(){
                            var $text_layer = jQuery("<div />")
                                .addClass("textLayer")
                                .css("height", viewport.height + "px")
                                .css("width", viewport.width + "px")
                                .offset({
                                    top: 0,
                                    left: 0
                                });
                            page.getTextContent().then(function(tc){
                                page_datum.n_page = n;
                                page_datum.n_page_total = page_data.length;
                                page_data[n] = page_datum;
                                resolve(page_data[n]);
                            });
                        });
                    }).catch(reject);
                }
            });

        };

        return pub;
    })();

    Pla.ctrl = (function(){
        var pub = {};

        var render_ctx = {};
        var cur_page = 0;
        var page_layout_js = [];

        pub.start = function(){
            /*
             init().then(
             runPLA
             ).catch(HandleErr);*/

            return Pla.util.checkEnv().then(
                init
            ).then(
                batchRunPla
            //).then(
            //    uploadPdfLayoutJs
            ).then(
                function(link){
                    //window.top.location.replace(link);
                }
            ).catch(Pla.util.handleErr);
        };

        var init = function(){
            document.onkeydown = onKeyDown;
            document.onmouseup = onMouseUp;

            render_ctx.scrx = $("#maincanvas").width();
            render_ctx.scry = $("#maincanvas").height();

            //Todo replace this with Pla.ctx
            var myuuid = Pla.util.GetParameterByName("uuid");
            var nfiles = Pla.util.GetParameterByName("nfiles");
            var pdf_path = Pla.util.GetServerUrl()+"mupla_pdfs/"+myuuid+"/";
            var pdf_filename = "merged.pdf";
            Pla.View.Init(render_ctx);

            var prom = Pla.model.Init(pdf_path, pdf_filename, nfiles)
            page_layout_js = new Array(Pla.model.getNumPages());
            return prom;
        };

        var batchRunPla = function(){
            return new Promise(function(resolve, reject){
                var job = function (){
                    if(cur_page != Pla.model.getNumPages()){
                        runPla().then(
                            function(){
                                cur_page += 1;
                                job();
                            }
                        ).catch(
                            reject
                        );
                    }
                    else{
                        cur_page -= 1;
                        resolve();
                    }
                };
                cur_page = 0;
                job();
            });
        };

        var uploadPdfLayoutJs = function(){
            return new Promise(
                function(resolve, reject){
                    var doc_layout_js = {
                        ver: 6.0,
                        pages: page_layout_js
                    };

                    var posting = $.ajax({
                        type: 'POST',
                        url: Pla.util.GetServerUrl()+"upload?mode=UploadDocLayout&uuid="+Pla.util.GetParameterByName("uuid"),
                        data: JSON.stringify(doc_layout_js),
                        contentType:"application/jsonrequest"
                    });

                    posting.success(function(resp){
                        resolve(resp);
                    });

                    posting.fail(function(resp){
                        reject(resp);
                    });

                }
            );
        };

        var runPla = function(){
            return Pla.model.getPdfPageData(cur_page).then(function(page){
                console.log("> runPla at page", cur_page);
                preprocessTextBoxes(
                    page.mupla,
                    {w: page.canvas.width, h: page.canvas.height}
                );

                var rects = page.mupla.GetRects();

                render_ctx.rects = rects;
                render_ctx.ycuts = Pla.XyCut.projectAndCutRectsY(rects);
                render_ctx.ycut_blocks = Pla.XyCut.getYCutBlocks(rects, render_ctx.ycuts);
                render_ctx.pla_ctx = Pla.XyCut.run(rects);
                render_ctx.multicolumn = Pla.multiColumn.run(render_ctx.pla_ctx, page.mupla.bbox);
                page_layout_js[cur_page] = {
                    bbox: page.mupla.bbox,
                    rgns: render_ctx.multicolumn};

                render_ctx.n_page = page.n_page;
                render_ctx.n_page_total = page.n_page_total;

                Pla.View.Render(render_ctx, page.canvas);
            }).catch(Pla.util.handleErr);
        };

        var preprocessTextBoxes = function(mupla, canvas_size){
            if(typeof mupla.resize_done === "undefined"){
                var ratio_x = canvas_size.w/(mupla.bbox[2]-mupla.bbox[0]);
                var ratio_y = canvas_size.h/(mupla.bbox[3]-mupla.bbox[1]);
                for(var i = 0; i < mupla.tblocks.length; ++i){
                    var lines = mupla.tblocks[i].lines;
                    for(var j = 0; j < lines.length; ++j){
                        var bbox = lines[j].bbox;
                        bbox[0] = ratio_x*bbox[0];
                        bbox[1] = ratio_y*bbox[1];
                        bbox[2] = ratio_x*bbox[2];
                        bbox[3] = ratio_y*bbox[3];
                    }
                }
                mupla.bbox[0] = mupla.bbox[0]*ratio_x;
                mupla.bbox[1] = mupla.bbox[1]*ratio_y;
                mupla.bbox[2] = mupla.bbox[2]*ratio_x;
                mupla.bbox[3] = mupla.bbox[3]*ratio_y;
                mupla.resize_done = true;
            }

            function isMostlyAlphaNumeric(l){
                var n_an = 0;
                for(var i = 0; i < l.length; ++i){
                    if(/^[., A-Za-z0-9]$/.test(l[i])){
                        n_an += 1;
                    }
                }
                return n_an >= l.length/2;
            }


            // filter out space only text boxes
            for(var i = 0; i < mupla.tblocks.length; ++i){
                var lines = mupla.tblocks[i].lines;
                for(var j = 0; j < lines.length; ++j){
                    if((/^\s*$/).test(lines[j].text) || !isMostlyAlphaNumeric(lines[j].text)){
                        lines.splice(j, 1);
                        --j;
                    }
                }
            }

            // filter out Page Number box
            var rects = mupla.GetRects();
            var bbox = Pla.rectUtil.getRectsBBox(rects);
            var range_y = [bbox[3]-Pla.Param.PAGENUM_DETECTION_RANGE_Y, bbox[3]];

            for(var i = 0; i < mupla.tblocks.length; ++i) {
                var lines = mupla.tblocks[i].lines;
                for (var j = 0; j < lines.length; ++j) {
                    var rect = lines[j].bbox;
                    if((/^([0-9]|\s)+$/).test(lines[j].text) && // number only text
                        Pla.rectUtil.testOverlapSegments(range_y, [rect[1], rect[3]])
                    ){
                        // Check other boxes nearby
                        var w = rect[2]-rect[0];
                        var h = rect[3]-rect[1];
                        var cx = (rect[0]+rect[2])*0.5;
                        var cy = (rect[1]+rect[3])*0.5;
                        var exp_rect = [cx-w, cy-h, cx+w, cy+h];
                        if(Pla.rectUtil.getOverlappingRects(exp_rect, rects).length == 1){
                            // Page Number's box detected
                            rect[0] = bbox[0];
                            rect[2] = bbox[2];
                        }
                    }
                }
            }
        };

        var onKeyDown = function(event){
            var turnPage = function(d){
                cur_page = cur_page + d;
                cur_page = Math.min(cur_page, Pla.model.getNumPages()-1);
                cur_page = Math.max(cur_page, 0);
            };

            switch(event.which){
                case 37: // L-arrow
                    turnPage(-1);
                    runPla();
                    break;
                case 39: // R-arrow
                    turnPage(+1);
                    runPla();
                    break;
                default:
                    break;
            }
        };

        var onMouseUp = function(event){
            var p = [event.clientX, event.clientY];
            Pla.model.getPdfPageData(cur_page).then(function(page){
                // Todo Fix it
                /*
                page.text_boxes.forEach(function(item){
                    var rect = item.bbox;
                    if(rect[0] < p[0] && p[0] < rect[2] &&
                        rect[1] < p[1] && p[1] < rect[3]
                    ){
                        console.log(
                            "mouse_pos:", JSON.stringify(p), ",",
                            rect[0].toFixed(2), rect[1].toFixed(2), rect[2].toFixed(2), rect[3].toFixed(2), ",",
                            item.text
                        );
                    }
                });*/
            }).catch(Pla.util.handleErr);
        };

        return pub;
    })();

    Pla.View = (function() {
        var pub = {};
        var dr_canvas = document.getElementById('maincanvas');
        var dr_ctx = dr_canvas.getContext('2d');

        pub.Init = function(render_ctx){
            dr_canvas.width = render_ctx.scrx;
            dr_canvas.height = render_ctx.scry;
        };

        pub.Render = function(render_ctx, canvas){
            dr_ctx.fillStyle = 'lightgray';
            dr_ctx.fillRect(0, 0, render_ctx.scrx, render_ctx.scry);

            dr_ctx.drawImage(canvas,
                0, 0, canvas.width, canvas.height,
                0, 0, canvas.width, canvas.height);


            dr_ctx.fillStyle = "black";
            dr_ctx.font = "bold 16px Arial";
            dr_ctx.textAlign = 'right';
            dr_ctx.fillText((render_ctx.n_page+1) + " / " + (render_ctx.n_page_total), 470, 30);

            var rects = render_ctx.rects;
            rects.forEach(function(rect){
                dr_ctx.strokeStyle = 'rgba(0, 0, 255, 0.5)';
                dr_ctx.lineWidth="1";
                dr_ctx.beginPath();
                dr_ctx.rect(rect[0], rect[1], rect[2]-rect[0], rect[3]-rect[1]);
                dr_ctx.stroke();
            });

            var ycuts = render_ctx.ycuts;
            var x = 2;
            ycuts.forEach(function(yi){
                dr_ctx.strokeStyle = 'rgba(255, 0, 0, 1.0)';
                dr_ctx.lineWidth="3";
                dr_ctx.beginPath();
                dr_ctx.moveTo(x, yi[0]);
                dr_ctx.lineTo(x, yi[1]);
                dr_ctx.stroke();
                x += 2;
            });

            if(false){
                var ycut_blocks = render_ctx.ycut_blocks;
                ycut_blocks.forEach(function(ycut_block){
                    var block = ycut_block.bbox;
                    dr_ctx.strokeStyle = 'rgba(0, 0, 255, 0.5)';
                    dr_ctx.lineWidth="2";
                    dr_ctx.beginPath();
                    dr_ctx.rect(block[0], block[1], block[2]-block[0], block[3]-block[1]);
                    dr_ctx.stroke();
                    x += 2;
                });
            }


            var pla_ctx = render_ctx.pla_ctx;
            for(var i = 0; i < pla_ctx.xcuts.length; ++i){
                pla_ctx.xcuts[i].forEach(function(cut){
                    dr_ctx.fillStyle = 'rgba(0, 255, 255, 0.25)';
                    dr_ctx.fillRect(
                        cut[0],
                        pla_ctx.ycut_blocks[i].bbox[1],
                        cut[1]-cut[0],
                        pla_ctx.ycut_blocks[i].bbox[3]-pla_ctx.ycut_blocks[i].bbox[1]
                    );
                });
            }

            // alley constraint lines
            dr_ctx.strokeStyle = 'rgba(50, 50, 50, 0.1)';
            dr_ctx.lineWidth="2";
            dr_ctx.beginPath();
            dr_ctx.moveTo(pla_ctx.alley_range[0], 0);
            dr_ctx.lineTo(pla_ctx.alley_range[0], canvas.height);
            dr_ctx.moveTo(pla_ctx.alley_range[1], 0);
            dr_ctx.lineTo(pla_ctx.alley_range[1], canvas.height);
            dr_ctx.stroke();


            if(true){ // color boxes differently
                var COLORS = [
                    "rgba(255, 0, 0, 0.25)",
                    "rgba(0, 255, 0, 0.25)",
                    "rgba(0, 0, 255, 0.25)",
                    "rgba(255, 0, 255, 0.25)"
                ];

                for(var i_rgn = 0; i_rgn < 4; ++i_rgn){
                    dr_ctx.fillStyle = COLORS[i_rgn];
                    for(var i = 0; i < pla_ctx.doublecolumn_rects[i_rgn].length; ++i){
                        var rect = pla_ctx.doublecolumn_rects[i_rgn][i];
                        dr_ctx.fillRect(
                            rect[0],
                            rect[1],
                            rect[2]-rect[0],
                            rect[3]-rect[1]
                        );
                    }
                }
            }


            var bgrp;
            for(var i = 0; bgrp = pla_ctx.block_group[i]; ++i){
                // block group bbox
                if(true){
                    var block = bgrp.bbox;
                    dr_ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                    dr_ctx.lineWidth="3";
                    dr_ctx.beginPath();
                    dr_ctx.rect(block[0], block[1], block[2]-block[0], block[3]-block[1]);
                    dr_ctx.stroke();
                    if(bgrp.alley){
                        dr_ctx.fillStyle = 'rgba(255, 0, 0, 0.25)';
                        dr_ctx.fillRect(
                            bgrp.alley[0],
                            block[1],
                            bgrp.alley[1]-bgrp.alley[0],
                            block[3]-block[1]
                        );
                    }
                }


                if(true) { // histogram analysis
                    dr_ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
                    for (var j = 1; j < bgrp.histogram_left.data.length - 2; ++j) {
                        dr_ctx.fillRect(
                            bgrp.histogram_left.data[j].p,
                            block[3],
                            bgrp.histogram_left.data[j + 1].p - bgrp.histogram_left.data[j].p,
                            -bgrp.histogram_left.data[j].wght / 2
                        );
                    }
                    if (bgrp.histogram_left.data.length > 2) {
                        dr_ctx.strokeStyle = 'rgba(0, 255, 0, 1.0)';
                        dr_ctx.lineWidth = "2";
                        var h = block[3] - bgrp.histogram_left.cut_threshold / 2;
                        dr_ctx.beginPath();
                        dr_ctx.moveTo(block[0] - 50, h);
                        dr_ctx.lineTo(block[2] + 50, h);
                        dr_ctx.stroke();
                    }

                    for (var j = 0; j < bgrp.histogram_left.thresholded_block.length; ++j) {
                        var threshold_block = bgrp.histogram_left.thresholded_block[j];
                        dr_ctx.strokeStyle = 'rgba(0, 150, 150, 1.0)';
                        dr_ctx.lineWidth = "2";
                        dr_ctx.beginPath();
                        dr_ctx.rect(
                            threshold_block.range[0],
                            block[3],
                            threshold_block.range[1] - threshold_block.range[0],
                            -threshold_block.wght / 2
                        );
                        dr_ctx.stroke();
                    }


                    for (var j = 1; j < bgrp.histogram_rght.data.length - 2; ++j) {
                        dr_ctx.fillRect(
                            bgrp.histogram_rght.data[j].p,
                            block[1],
                            bgrp.histogram_rght.data[j + 1].p - bgrp.histogram_rght.data[j].p,
                            bgrp.histogram_rght.data[j].wght / 2
                        );
                    }
                    if (bgrp.histogram_rght.data.length > 2) {
                        dr_ctx.strokeStyle = 'rgba(0, 255, 0, 1.0)';
                        dr_ctx.lineWidth = "2";
                        var h = block[1] + bgrp.histogram_rght.cut_threshold / 2;
                        dr_ctx.beginPath();
                        dr_ctx.moveTo(block[0] - 50, h);
                        dr_ctx.lineTo(block[2] + 50, h);
                        dr_ctx.stroke();
                    }
                    for (var j = 0; j < bgrp.histogram_rght.thresholded_block.length; ++j) {
                        var threshold_block = bgrp.histogram_rght.thresholded_block[j];
                        dr_ctx.strokeStyle = 'rgba(0, 150, 150, 1.0)';
                        dr_ctx.lineWidth = "2";
                        dr_ctx.beginPath();
                        dr_ctx.rect(
                            threshold_block.range[0],
                            block[1],
                            threshold_block.range[1] - threshold_block.range[0],
                            threshold_block.wght / 2
                        );
                        dr_ctx.stroke();
                    }
                }
            }

            if(false){ // final cutting boxes
                for(var idx_rgn = 0; idx_rgn < 4; ++idx_rgn){
                    for(var i = 0; i < render_ctx.multicolumn[idx_rgn].rects.length; ++i){
                        var box = render_ctx.multicolumn[idx_rgn].rects[i];
                        if(i%2==0){
                            dr_ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                        }
                        else{
                            dr_ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
                        }
                        dr_ctx.lineWidth="1";
                        dr_ctx.beginPath();
                        dr_ctx.rect(
                            box[0],
                            box[1],
                            box[2]-box[0],
                            box[3]-box[1]
                        );
                        dr_ctx.stroke();
                    }
                }
            }

        };

        return pub;
    })();

}(window.Pla = window.Pla || {}));
