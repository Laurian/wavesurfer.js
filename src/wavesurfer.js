'use strict';

var WaveSurfer = {
    defaultParams: {
        waveColor     : '#999',
        progressColor : '#333',
        cursorColor   : '#ddd',
        cursorWidth   : 1,
        markerWidth   : 1,
        skipLength    : 2,
        minPxPerSec   : 1,
        pixelRatio    : 1,
        fillParent    : true,
        scrollParent  : false,
        normalize     : false,
        audioContext  : null,
        container     : null,
        renderer      : 'Canvas'
    },

    init: function (params) {
        // Extract relevant parameters (or defaults)
        this.params = WaveSurfer.util.extend({}, this.defaultParams, params);

        // Marker objects
        this.markers = {};

        // Used to save the current volume when muting so we can
        // restore once unmuted
        this.savedVolume = 0;
        // The current muted state
        this.isMuted = false;

        this.createBackend();
        this.createDrawer();
    },

    createDrawer: function () {
        var my = this;

        this.drawer = Object.create(WaveSurfer.Drawer[this.params.renderer]);
        this.drawer.init(this.params);

        this.drawer.on('redraw', function () {
            my.drawBuffer();
        });

        this.drawer.on('click', function (progress) {
            my.seekTo(progress);
        });

        this.on('progress', function (progress) {
            my.drawer.progress(progress);
        });
    },

    createBackend: function () {
        var my = this;

        this.backend = Object.create(WaveSurfer.WebAudio);

        this.backend.on('play', function () {
            my.fireEvent('play');
        });

        this.on('play', function () {
            my.restartAnimationLoop();
        });

        this.backend.init(this.params);
    },

    restartAnimationLoop: function () {
        var my = this;
        var requestFrame = window.requestAnimationFrame ||
            window.webkitRequestAnimationFrame;
        var frame = function () {
            my.fireEvent('progress', my.backend.getPlayedPercents());
            if (!my.backend.isPaused()) {
                requestFrame(frame);
            }
        };
        frame();
    },

    playAt: function (percents) {
        this.backend.play(this.backend.getDuration() * percents);
    },

    play: function () {
        this.backend.play();
    },

    pause: function () {
        this.backend.pause();
    },

    playPause: function () {
        this.backend.isPaused() ? this.play() : this.pause();
    },

    skipBackward: function (seconds) {
        this.skip(seconds || -this.params.skipLength);
    },

    skipForward: function (seconds) {
        this.skip(seconds || this.params.skipLength);
    },

    skip: function (offset) {
        var timings = this.timings(offset);
        var progress = timings[0] / timings[1];

        this.seekTo(progress);
    },

    seekTo: function (progress) {
        var paused = this.backend.isPaused();
        this.playAt(progress);
        if (paused) {
            this.pause();
            this.fireEvent('progress', progress);
        }
        this.fireEvent('seek', progress);
    },

    stop: function () {
        this.playAt(0);
        this.pause();
        this.drawer.progress(0);
    },

    /**
     * Set the playback volume.
     *
     * @param {Number} newVolume A value between -1 and 1, -1 being no
     * volume and 1 being full volume.
     */
    setVolume: function (newVolume) {
        this.backend.setVolume(newVolume);
    },

    /**
     * Toggle the volume on and off. It not currenly muted it will
     * save the current volume value and turn the volume off.
     * If currently muted then it will restore the volume to the saved
     * value, and then rest the saved value.
     */
    toggleMute: function () {
        if (this.isMuted) {
            // If currently muted then restore to the saved volume
            // and update the mute properties
            this.backend.setVolume(this.savedVolume);
            this.isMuted = false;
        } else {
            // If currently not muted then save current volume,
            // turn off the volume and update the mute properties
            this.savedVolume = this.backend.getVolume();
            this.backend.setVolume(0);
            this.isMuted = true;
        }
    },

    mark: function (options) {
        var my = this;
        var opts = WaveSurfer.util.extend({
            id: WaveSurfer.util.getId(),
            position: this.backend.getCurrentTime(),
            width: this.params.markerWidth
        }, options);

        var marker = Object.create(WaveSurfer.Mark);

        marker.on('update', function () {
            var duration = my.backend.getDuration() || 1;
            if (null == marker.position) {
                marker.position = marker.percentage * duration;
            }
            // validate percentage
            marker.percentage = marker.position / duration;
            my.drawer.addMark(marker);
            my.markers[marker.id] = marker;
        });

        marker.on('remove', function () {
            my.drawer.removeMark(marker);
            delete my.markers[marker.id];
        });

        return marker.update(opts);
    },

    clearMarks: function () {
        Object.keys(this.markers).forEach(function (id) {
            this.markers[id].remove();
        }, this);
    },

    timings: function (offset) {
        var position = this.backend.getCurrentTime() || 0;
        var duration = this.backend.getDuration() || 1;
        position = Math.max(0, Math.min(duration, position + (offset || 0)));
        return [ position, duration ];
    },

    drawBuffer: function () {
        // Update percentage on any markers added before the audio loaded.
        var duration = this.backend.getDuration() || 1;
        Object.keys(this.markers).forEach(function (id) {
            var marker = this.markers[id];
            marker.update({ percentage: marker.position / duration });
        }, this);

        var pixels = this.drawer.getPixels(duration);
        var peaks = this.backend.getPeaks(pixels);
        var max = this.backend.getMaxPeak(peaks);

        this.drawer.drawPeaks(peaks, max);
    },

    loadBuffer: function (data) {
        var my = this;
        this.pause();
        this.backend.loadBuffer(data, function () {
            my.drawBuffer();
            my.fireEvent('ready');
        }, function () {
            my.fireEvent('decode-error');
        });
    },

    onProgress: function (e) {
        if (e.lengthComputable) {
            var percentComplete = e.loaded / e.total;
        } else {
            // Approximate progress with an asymptotic
            // function, and assume downloads in the 1-3 MB range.
            percentComplete = e.loaded / (e.loaded + 1000000);
        }
        this.fireEvent('loading', Math.round(percentComplete * 100), e.target);
    },

    /**
     * Loads an audio file via XHR.
     */
    load: function (url) {
        var my = this;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.send();
        xhr.responseType = 'arraybuffer';
        xhr.addEventListener('progress', function (e) {
            my.onProgress(e);
        });
        xhr.addEventListener('load', function (e) {
            if (e.target.response) {
                my.loadBuffer(e.target.response);
            } else {
                my.fireEvent('load-error');
            }
        });
        xhr.addEventListener('error', function () {
            my.fireEvent('load-error');
        });
        this.empty();
    },

    /**
     * Listens to drag'n'drop.
     * @param {HTMLElement|String} dropTarget Element or selector.
     */
    bindDragNDrop: function (dropTarget) {
        var my = this;

        // Create file reader
        var reader = new FileReader();
        reader.addEventListener('progress', function (e) {
            my.onProgress(e);
        });
        reader.addEventListener('load', function (e) {
            my.loadBuffer(e.target.result);
        });
        reader.addEventListener('error', function () {
            my.fireEvent('load-error');
        });

        // Bind drop event
        if (typeof dropTarget == 'string') {
            dropTarget = document.querySelector(dropTarget);
        }
        var dropActiveCl = 'wavesurfer-dragover';
        dropTarget.addEventListener('drop', function (e) {
            e.stopPropagation();
            e.preventDefault();
            dropTarget.classList.remove(dropActiveCl);
            var file = e.dataTransfer.files[0];
            if (file) {
                reader.readAsArrayBuffer(file);
                my.empty();
            } else {
                my.fireEvent('load-error');
            }
        });
        // Bind dragover & dragleave
        dropTarget.addEventListener('dragover', function (e) {
            e.stopPropagation();
            e.preventDefault();
            dropTarget.classList.add(dropActiveCl);
        });
        dropTarget.addEventListener('dragleave', function (e) {
            e.stopPropagation();
            e.preventDefault();
            dropTarget.classList.remove(dropActiveCl);
        });
    },

    // TODO: use scheduling instead of `onaudioprocess'
    bindMarks: function () {
        var my = this;
        this.backend.createScriptNode();
        this.backend.on('audioprocess', function () {
            Object.keys(my.markers).forEach(function (id) {
                var marker = my.markers[id];
                var position = marker.position.toPrecision(3);
                var time = my.backend.getCurrentTime().toPrecision(3);
                if (position == time) {
                    my.fireEvent('mark', marker);
                    marker.fireEvent('reached');
                }
            });
        });
    },

    empty: function () {
        this.pause();
        this.backend.loadEmpty();
        this.drawer.drawPeaks({ length: this.drawer.getWidth() }, 0);
    }
};


/* Mark */
WaveSurfer.Mark = {
    id: null,
    position: 0,
    percentage: 0,
    width: 1,
    color: '',

    getTitle: function () {
        var d = new Date(this.position * 1000);
        return d.getMinutes() + ':' + d.getSeconds();
    },

    update: function (options) {
        Object.keys(options).forEach(function (key) {
            if (key in this) {
                this[key] = options[key];
            }
        }, this);
        if (null == options.position && null != options.percentage) {
            this.position = null;
        }
        this.fireEvent('update');
        return this;
    },

    remove: function () {
        this.fireEvent('remove');
    }
};

/* Observer */
WaveSurfer.Observer = {
    on: function (event, fn) {
        if (!this.handlers) { this.handlers = {}; }

        var handlers = this.handlers[event];
        if (!handlers) {
            handlers = this.handlers[event] = [];
        }
        handlers.push(fn);
    },

    un: function (event, fn) {
        if (!this.handlers) { return; }

        var handlers = this.handlers[event];
        if (handlers) {
            if (fn) {
                for (var i = handlers.length - 1; i >= 0; i--) {
                    if (handlers[i] == fn) {
                        handlers.splice(i, 1);
                    }
                }
            } else {
                handlers.length = 0;
            }
        }
    },

    fireEvent: function (event) {
        if (!this.handlers) { return; }

        var handlers = this.handlers[event];
        var args = Array.prototype.slice.call(arguments, 1);
        if (handlers) {
            for (var i = 0, len = handlers.length; i < len; i += 1) {
                handlers[i].apply(null, args);
            }
        }
    }
};

/* Common utilities */
WaveSurfer.util = {
    extend: function (dest) {
        var sources = Array.prototype.slice.call(arguments, 1);
        sources.forEach(function (source) {
            if (source != null) {
                Object.keys(source).forEach(function (key) {
                    dest[key] = source[key];
                });
            }
        });
        return dest;
    },

    getId: function () {
        return 'wavesurfer_' + Math.random().toString(32).substring(2);
    },

    max: function (values) {
        var max = -Infinity;
        for (var i = 0, len = values.length; i < len; i++) {
            var val = values[i];
            if (val > max) { max = val; }
        }
        return max;
    }
};

WaveSurfer.util.extend(WaveSurfer, WaveSurfer.Observer);
WaveSurfer.util.extend(WaveSurfer.Mark, WaveSurfer.Observer);
