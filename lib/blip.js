var EventEmitter = require('events').EventEmitter,
	fs = require('fs'),
	os = require('os'),
	util = require('util'),
	zlib = require('zlib'),
	gd = require('node-gd')

blip = {}

var hexNum = function(val) {
	val = val.toString(16)
	if(val.length === 1) val = '0' + val
	return val
}

/**
 * blip encoder object
 * constructor
 * @param <Object> options - Object of all options to use for the encoder. Some are mandatory
 *   valid options:
 *     <String> destination - path to save the resulting image to. Required.
 *     <Int> mode - Flag (using encoder.modes) to indicate the encode mode to use. Required.
 *     <Object> gzip - Object containing gzip compression options to pass to zlib module. Reference nodejs docs for zlib. Optional.
 *     <Array> regions - Array of region objects to use to embed the image within. Required for EMBED mode, ignored for OVERWRITE mode.
 *     <Int> width - Width of the image to write. Required for OVERWRITE mode, ignored for EMBED mode.
 *     <Object> profileBytes - Object of "profile bytes", to indicate specific bytes to modify in the image; ignored for OVERWRITE mode.
 *     <String> tmpFile - the path to the temporary file used to store gzipped data before writing to the image. defaults to `os.tmpDir() + '/blip_' + process.pid + '.tmp'`.
 *     <String> source - Source file to use when embedding into an existing image. Required for EMBED mode, ignored for OVERWRITE mode.
 */
encoder = function(options) {
	var self = this
	if(options === undefined)
		throw new Error('no options provided to encoder')

	this.gdImage = null
	this.dest = options.destination
	this.mode = options.mode || encoder.modes.OVERWRITE
	// trying to lower memory requirements...provide {} for zlib defaults
	this.gzipOptions = options.gzip || {
		windowBits: 13,
		memLevel: 6,
	}
	this.profile = encoder.profiles.ERROR

	if(this.mode === encoder.modes.EMBED) {
		if(!options.regions)
			throw new Error('no embed regions provided')

		if(!options.source)
			throw new Error('no embed source image provided')
		this.source = options.source

		if(!util.isArray(options.regions)) {
			this.regions = [options.regions]
		} else {
			this.regions = options.regions
		}

		// we need to process region sizes now, find out how much room we have to work with...
		this.regionSize = this.regions.reduce(function(total, region) {
			return total + (region.x2 - region.x1 + 1) * (region.y2 - region.y1 + 1)
		}, 0)

		// @todo populate on image open
		this.width = null
		this.height = null
		this.profileBytes = options.profileBytes || {
			R: encoder.bytes.OVERWRITE,
			G: encoder.bytes.OVERWRITE,
			B: encoder.bytes.OVERWRITE,
		}
		this.xorByte = false
	} else if(this.mode === encoder.modes.OVERWRITE) {
		if(!options.width || options.width <= 0)
			throw new Error('width must be defined and greater than 0')

		this.source = null
		this.regionSize = null
		this.regions = []
		this.width = options.width
		this.height = null
		this.profileBytes = {
			R: encoder.bytes.OVERWRITE,
			G: encoder.bytes.OVERWRITE,
			B: encoder.bytes.OVERWRITE,
		}
		this.xorByte = false
	} else {
		throw new Error('invalid encode mode specified')
	}

	if(this.profileBytes['R'] === encoder.bytes.PRESERVE) {
		this.xorByte = 'R'
	} else if(this.profileBytes['R'] === encoder.bytes.OVERWRITE) {
		this.profile++
	} else if(this.profileBytes['R'] === encoder.bytes.WRITEXOR) {
		this.xorByte = true // set to true for now to indicate we ARE looking for an xor byte.
	}

	if(this.profileBytes['G'] === encoder.bytes.PRESERVE && (this.xorByte === true || this.xorByte === false)) {
		// only set xor byte if we don't have one already
		this.xorByte = 'G'
	} else if(this.profileBytes['G'] === encoder.bytes.OVERWRITE) {
		this.profile++
	} else if(this.profileBytes['G'] === encoder.bytes.WRITEXOR && (this.xorByte !== true && this.xorByte !== false)) {
		this.xorByte = true // set to true for now to indicate we ARE looking for an xor byte. do not overwrite if we already have an xor byte.
	}

	if(this.profileBytes['B'] === encoder.bytes.PRESERVE && (this.xorByte === true || this.xorByte === false)) {
		// only set xor byte if we don't have one already
		this.xorByte = 'B'
	} else if(this.profileBytes['B'] === encoder.bytes.OVERWRITE) {
		this.profile++
	} else if(this.profileBytes['B'] === encoder.bytes.WRITEXOR && (this.xorByte !== true && this.xorByte !== false)) {
		this.xorByte = true // set to true for now to indicate we ARE looking for an xor byte. do not overwrite if we already have an xor byte.
	}

	// if boolean true, we never got our xor byte.
	if(this.xorByte === true)
		throw new Error('using a profileByte set as WRITEXOR, no spare byte left over as PRESERVE to xor against')
	if(this.profile === encoder.profiles.ERROR)
		throw new Error('no bytes specified for data write in pixels...so, where am I supposed to put the data?')

	this.tmpFile = options.tmpFile || os.tmpdir() + '/blip_' + process.pid + '.tmp'

	EventEmitter.call(this)
}
encoder.modes = {
	OVERWRITE: 1, // overwriting all image data
	EMBED: 2, // embedding message on top of existing image data (need regions defined for this!)
}
encoder.profiles = {
	ERROR: 0, // error state
	NIBBLE: 1, // bury data in one RGB value... (hard to detect)
	BITE: 2, // bury data in two RGB values...
	GORGE: 3, // fuck it, just overwrite the entire damn pixel (better performance)
}
encoder.bytes = {
	PRESERVE: 0, // keep original value
	OVERWRITE: 1, // overwrite value with new
	WRITEXOR: 2, // xor current byte against first PRESERVE byte in pixel. (cannot be used on R value)
}
Object.freeze(encoder.mode)
Object.freeze(encoder.profiles)
Object.freeze(encoder.bytes)
util.inherits(encoder, EventEmitter)

/**
 * gzip compresses, then encodes given data into hexadecimal, performing necessary padding to ensure well-rounded data (must be .length % 6 == 0)
 * @param $input string - string to convert
 * @param $fn callback - callable function, of format:
 *   fn(err, totalBytes, chunkFn)
 *   $err - null if no error, or Error object if something went wrong
 *   $totalBytes - undefined if error, or integer of total bytes of gzip'd data
 *   $chunkFn - callable function which will return in gz'd data in chunks
 *
 * @access private
 */
encoder.prototype.__encode = function(input, fn) {
	var self = this
	try {
		var gzip = zlib.createGzip(this.gzipOptions), tmpFile
		if(input.readable !== undefined && input.readable === false) {
			throw new TypeError('readable stream required for __encode, non-readable stream provided')
		} else {
			tmpFile = fs.createWriteStream(this.tmpFile, { encoding: 'utf8' })
			gzip.on('close', function() {
				// create tmp file...
				tmpFile = fs.createReadStream(self.tmpFile, { encoding: 'utf8' })
				var totalBytes = fs.statSync(self.tmpFile).size

				// Returning a special function that will allow us to take a chunk at a time for rendering into each pixel.
				// Hopefully, this should decrease memory use.
				fn(null, totalBytes, function(chunkSize) {
					var chunk = new Buffer(tmpFile.read(chunkSize || 3), 'utf8').toString('hex'), tBuffer
					if(chunk === null) return null
					if(chunk.length % 6 !== 0) {
						tBuffer = new Buffer(chunk.length % 6)
						tBuffer.fill(' ')
						chunk = Buffer.concat([chunk, tBuffer])
					}
					return chunk
				}, tmpFile)
			})

			if(input.readable === undefined) {
				gzip.pipe(tmpFile)
				gzip.write(new Buffer(input, 'utf8'))
			} else {
				input.pipe(gzip).pipe(tmpFile)
			}
		}
	} catch(err) {
		fn(err)
	}
}

encoder.prototype.write = function(input, fn) {
	var self = this
	try {
		if(this.mode === encoder.modes.OVERWRITE) {
			this.__encode(input, function(err, totalBytes, chunkFn, tmpFile) {
				if(err) throw err

				// take totalBytes, div by self.profile (as it contains the usable bytes per pixel).
				var pixels = Math.ceil(totalBytes / self.profile)
				self.height = Math.ceil(pixels / self.width)
				self.regionSize = self.width * self.height
				if(self.regionSize < pixels)
					throw new Error(util.format('insuffient region area to store provided data, need %s pixels', pixels))

				self.regions.push({
					x1: 0,
					x2: self.width - 1,
					y1: 0,
					y2: self.height - 1,
				})
				self.gdImage = gd.createTrueColor(width, height)
				fn(null, self.__write(chunkFn, tmpFile)) // totally deliberate
			})
		} else if(this.mode === encoder.modes.EMBED) {
			this.__encode(input, function(err, totalBytes, chunkFn, tmpFile) {
				if(err) throw err

				var pixels = Math.ceil(totalBytes / self.profile)
				if(self.regionSize < pixels)
					throw new Error(util.format('insuffient region area to store provided data, need %s pixels', pixels))

				gd.openPng(self.source, function(err, gdImage) {
					if(err) throw err
					self.width = gdImage.width
					self.height = gdImage.height
					self.gdImage = gdImage

					fn(null, self.__write(chunkFn, tmpFile))
				})
			})
		} else {
			// this should not be possible. should have been caught farther up in the stack.
			throw new Error('invalid encode mode specified')
		}
	} catch(err) {
		fn(err)
	}
}

encoder.prototype.__write = function(chunkFn, tmpFile) {
	var self = this, colors = {}, br = false, chunkSize = this.profile, gdImage = this.gdImage
	self.regions.forEach(function(region) {
		var x, y, r, g, b, hex, pixel, i, xor
		if(region.x1 > gdImage.width || region.x2 > gdImage.width || region.y1 > gdImage.height || region.y2 > gdImage.height)
			throw new Error('invalid region coordinates specified, not within actual image boundaries')

		for(y = region.y1; y <= region.y2; y++) {
			for(x = region.x1; x <= region.x2; x++) {
				i = 0
				hex = chunkFn(chunkSize)
				if(hex === null)
					hex = new Array(chunkSize + 1).join('FF')

				if(chunkSize !== 3)
					pixel = gdImage.getPixel(x, y)

				if(self.profileBytes['R'] === encoder.bytes.OVERWRITE) {
					r = parseInt(hex.slice(i,i + 2), 16)
					i+=2
				} else {
					r = gdImage.red(pixel)
					if(self.xorByte === 'R')
						xor = r
				}
				if(self.profileBytes['G'] === encoder.bytes.OVERWRITE) {
					g = parseInt(hex.slice(i,i + 2), 16)
					i+=2
				} else {
					g = gdImage.green(pixel)
					if(self.xorByte === 'G')
						xor = g
				}
				if(self.profileBytes['B'] === encoder.bytes.OVERWRITE) {
					b = parseInt(hex.slice(i,i + 2), 16)
					i+=2
				} else {
					b = gdImage.blue(pixel)
					if(self.xorByte === 'B')
						xor = b
				}

				// second pass for xor, has to come after.
				if(self.profileBytes['R'] === encoder.bytes.WRITEXOR)
					r = r ^ xor
				if(self.profileBytes['G'] === encoder.bytes.WRITEXOR)
					g = g ^ xor
				if(self.profileBytes['B'] === encoder.bytes.WRITEXOR)
					b = b ^ xor

				hex = hexNum(r) + hexNum(g) + hexNum(b)

				// cache color allocation
				if(colors[hex] === undefined)
					colors[hex] = gdImage.colorAllocate(r, g, b)
				gdImage.setPixel(x, y, colors[hex])
			}
		}
	})

	gdImage.savePng(this.dest, 0, gd.noop)
	fs.unlinkSync(this.tmpFile)

	return dest
}

var decoder = function() {
	// asdf
}
util.inherits(decoder, EventEmitter)

/**
 * trims extra padding, then splits, gzip decompresses and normalizes pixel chunks
 * @param $data string - hexadecimal blob of data extracted from blip-encoded image
 * @param $fn callback - callable function, of format:
 *   fn(err, res)
 *   $err - null if no error, or Error object if something went wrong
 *   $res - undefined if error, or string if decode successful
 *
 * @access private
 *
 * @todo rewrite to use data streaming for decreased memory use
 */
blip._decode = function(data, fn) {
	try {
		extra = data.match(/f+$/)
		if(extra !== null && (extra[0].length / 6) > 0) {
			data = data.slice(0, Math.floor(extra[0].length / 6) * -6)
		}

		zlib.gunzip(Buffer(data, 'hex'), function(err, res) {
			if(err) throw err
			fn(null, res.toString())
		})
	} catch(err) {
		fn(err)
	}
}

/**
 * read out the raw pixel information from the given image and turn it into a straightforward hexadecimal string
 * @param $gdImage gdimage - the node-gd gdimage object to read data from
 * @param $x1 integer - the starting x-axis coordinate to read from
 * @param $x2 integer - the ending x-axis coordinate to read from
 * @param $y1 integer - the starting y-axis coordinate to read from
 * @param $y2 integer - the ending y-axis coordinate to read from
 * @param $fn callback - callable function, of format:
 *   fn(err, res)
 *   $err - null if no error, or Error object if something went wrong
 *   $res - undefined if error, or string if decode successful
 *
 * @access private
 */
blip._fromImage = function(gdImage, x1, x2, y1, y2, fn) {
	var px, x, y, r, g, b, data = ''
	for(y = y1; y <= y2; y++) {
		for(x = x1; x <= x2; x++) {
			px = gdImage.getPixel(x, y)
			r = gdImage.red(px).toString(16), g = gdImage.green(px).toString(16), b = gdImage.blue(px).toString(16)
			if(r.length === 1) r = '0' + r
			if(g.length === 1) g = '0' + g
			if(b.length === 1) b = '0' + b
			data += r + g + b
		}
	}

	blip._decode(data, fn)
}

/**
 * read data out from a complete image
 * @param $image string - the filename of the image to read
 * @param $fn callback - callable function, of format:
 *   fn(err, res)
 *   $err - null if no error, or Error object if something went wrong
 *   $res - undefined if error, or string if decode successful
 */
blip.fromImage = function(image, fn) {
	try {
		gd.openPng(image, function(err, gdImage) {
			if(err) throw err
			blip._fromImage(gdImage, 0, gdImage.width - 1, 0, gdImage.height - 1, fn)
		})
	} catch(err) {
		fn(err)
	}
}

/**
 * read out data from a specified area within an image
 * @param $image string - the filename of the image to read
 * @param $x1 integer - the starting x-axis coordinate to read from
 * @param $x2 integer - the ending x-axis coordinate to read from
 * @param $y1 integer - the starting y-axis coordinate to read from
 * @param $y2 integer - the ending y-axis coordinate to read from
 * @param $fn callback - callable function, of format:
 *   fn(err, res)
 *   $err - null if no error, or Error object if something went wrong
 *   $res - undefined if error, or string if decode successful
 */
blip.fromImageEmbed = function(image, x1, x2, y1, y2, fn) {
	try {
		if(x1 < 0 || y1 < 0 || x1 > x2 || y1 > y2)
			throw new Error('invalid image coordinates specified')
		gd.openPng(image, function(err, gdImage) {
			if(err) throw err
			if(x1 > gdImage.width || x2 > gdImage.width || y1 > gdImage.height || y2 > gdImage.height)
				throw new Error('invalid image coordinates specified, not within actual image boundaries')
			blip._fromImage(gdImage, x1, x2, y1, y2, fn)
		})
	} catch (err) {
		fn(err)
	}
}

module.exports = blip
blip = {
	encoder: encoder,
	decoder: decoder,
}
